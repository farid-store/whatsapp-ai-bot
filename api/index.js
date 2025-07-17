// api/index.js

// Memuat variabel lingkungan dari file .env (hanya untuk pengembangan lokal)
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

// Inisialisasi Firebase Admin SDK
let serviceAccount;
try {
    serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
} catch (error) {
    console.error("Error parsing FIREBASE_SERVICE_ACCOUNT_BASE64:", error);
    // Ini akan mencegah aplikasi dimulai jika variabel lingkungan tidak diatur dengan benar
    process.exit(1);
}

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// Inisialisasi Bot Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// Variabel global untuk menyimpan instance klien WhatsApp dan QR code
// Ini akan di-reset setiap kali fungsi Vercel di-invoke (karena stateless)
// Namun, RemoteAuth akan memastikan sesi dimuat dari Firestore
let whatsappClient = null;
let qrCodeData = null; // Untuk menyimpan QR code terakhir yang dihasilkan
let clientStatus = 'idle'; // idle, connecting, ready, disconnected

// --- Custom Firestore Session Store (Adaptasi dari wwebjs-mongo) ---
// Ini adalah implementasi RemoteAuth yang akan berinteraksi dengan Firestore
class FirestoreStore {
    constructor(firestoreDb, collectionName = 'whatsapp_sessions') {
        this.db = firestoreDb;
        this.collection = this.db.collection(collectionName);
        this.sessionRef = this.collection.doc('session_data'); // Hanya satu dokumen untuk sesi
    }

    async save(session) {
        try {
            await this.sessionRef.set({ session: JSON.stringify(session) });
            console.log('Sesi WhatsApp berhasil disimpan ke Firestore.');
        } catch (error) {
            console.error('Gagal menyimpan sesi WhatsApp ke Firestore:', error);
        }
    }

    async extract() {
        try {
            const doc = await this.sessionRef.get();
            if (doc.exists) {
                const data = doc.data();
                if (data && data.session) {
                    console.log('Sesi WhatsApp berhasil dimuat dari Firestore.');
                    return JSON.parse(data.session);
                }
            }
            console.log('Tidak ada sesi WhatsApp yang ditemukan di Firestore.');
            return null;
        } catch (error) {
            console.error('Gagal memuat sesi WhatsApp dari Firestore:', error);
            return null;
        }
    }

    async delete() {
        try {
            await this.sessionRef.delete();
            console.log('Sesi WhatsApp berhasil dihapus dari Firestore.');
        } catch (error) {
            console.error('Gagal menghapus sesi WhatsApp dari Firestore:', error);
        }
    }
}

const store = new FirestoreStore(db);

// --- Fungsi untuk Menginisialisasi Klien WhatsApp ---
const initializeWhatsAppClient = async () => {
    if (whatsappClient && clientStatus !== 'disconnected') {
        console.log('Klien WhatsApp sudah berjalan atau dalam proses.');
        return;
    }

    console.log('Menginisialisasi klien WhatsApp...');
    clientStatus = 'connecting';

    whatsappClient = new Client({
        authStrategy: new RemoteAuth({
            clientId: 'whatsapp-bot', // ID unik untuk sesi ini
            store: store
        }),
        puppeteer: {
            headless: true, // Jalankan browser dalam mode headless (tanpa GUI)
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // Wajib untuk Vercel
                '--disable-gpu'
            ]
        }
    });

    whatsappClient.on('qr', async (qr) => {
        console.log('QR RECEIVED', qr);
        qrCodeData = qr; // Simpan QR code
        try {
            const qrImageBase64 = await qrcode.toDataURL(qr);
            const buffer = Buffer.from(qrImageBase64.split(',')[1], 'base64');

            // Kirim QR code ke Telegram
            await telegramBot.sendPhoto(TELEGRAM_CHAT_ID, buffer, { caption: 'Scan QR ini untuk menghubungkan WhatsApp Anda.' });
            console.log('QR code berhasil dikirim ke Telegram.');
        } catch (error) {
            console.error('Gagal mengirim QR code ke Telegram:', error);
        }
    });

    whatsappClient.on('ready', () => {
        console.log('Klien WhatsApp siap!');
        clientStatus = 'ready';
        qrCodeData = null; // Hapus QR code setelah terhubung
    });

    whatsappClient.on('authenticated', () => {
        console.log('Klien WhatsApp terautentikasi!');
    });

    whatsappClient.on('auth_failure', msg => {
        // Fired if session restore failed
        console.error('AUTHENTICATION FAILURE', msg);
        clientStatus = 'disconnected';
        // Hapus sesi dari Firestore jika autentikasi gagal
        store.delete();
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('Klien WhatsApp terputus:', reason);
        clientStatus = 'disconnected';
        whatsappClient = null; // Reset klien
        // Hapus sesi dari Firestore saat terputus (opsional, tergantung kebutuhan)
        // store.delete();
    });

    // Contoh pendengar pesan (ini hanya akan berfungsi selama fungsi Vercel aktif)
    whatsappClient.on('message', message => {
        console.log('Pesan diterima:', message.body);
        if (message.body === '!ping') {
            message.reply('pong');
        }
    });

    try {
        await whatsappClient.initialize();
        console.log('Inisialisasi klien WhatsApp selesai.');
    } catch (error) {
        console.error('Gagal menginisialisasi klien WhatsApp:', error);
        clientStatus = 'disconnected';
        whatsappClient = null;
    }
};

// --- Setup Express App untuk Vercel ---
const app = express();
app.use(bodyParser.json());

// Endpoint untuk memulai inisialisasi WhatsApp dan mendapatkan QR
app.get('/api/start-whatsapp', async (req, res) => {
    if (clientStatus === 'ready') {
        return res.status(200).json({ status: 'ready', message: 'Klien WhatsApp sudah terhubung.' });
    }
    if (clientStatus === 'connecting') {
        return res.status(200).json({ status: 'connecting', message: 'Klien WhatsApp sedang dalam proses koneksi. Silakan cek endpoint /api/qr untuk QR code.' });
    }

    // Panggil fungsi inisialisasi
    initializeWhatsAppClient();

    res.status(200).json({
        status: 'initializing',
        message: 'Klien WhatsApp sedang diinisialisasi. Silakan refresh halaman /api/qr setelah beberapa detik untuk mendapatkan QR code.',
        note: 'Perhatikan bahwa pada Vercel, fungsi ini akan berakhir setelah beberapa waktu. Anda mungkin perlu memanggilnya lagi jika QR code tidak muncul atau sesi terputus.'
    });
});

// Endpoint untuk mendapatkan QR code via web
app.get('/api/qr', async (req, res) => {
    if (qrCodeData) {
        try {
            const qrImageBase64 = await qrcode.toDataURL(qrCodeData);
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': Buffer.byteLength(qrImageBase64.split(',')[1], 'base64')
            });
            res.end(Buffer.from(qrImageBase64.split(',')[1], 'base64'));
        } catch (error) {
            console.error('Gagal menghasilkan gambar QR:', error);
            res.status(500).send('Gagal menghasilkan gambar QR.');
        }
    } else if (clientStatus === 'ready') {
        res.status(200).send('Klien WhatsApp sudah terhubung. Tidak ada QR code yang tersedia.');
    } else if (clientStatus === 'connecting') {
        res.status(200).send('Klien WhatsApp sedang dalam proses koneksi. QR code akan segera muncul.');
    } else {
        res.status(404).send('Tidak ada QR code yang tersedia. Silakan panggil /api/start-whatsapp terlebih dahulu.');
    }
});

// Endpoint untuk mendapatkan status klien WhatsApp
app.get('/api/status', (req, res) => {
    res.status(200).json({ status: clientStatus });
});

// Export aplikasi Express untuk Vercel
module.exports = app;

// Opsional: Jalankan server secara lokal untuk pengujian
// if (process.env.NODE_ENV !== 'production') {
//     const PORT = process.env.PORT || 3000;
//     app.listen(PORT, () => {
//         console.log(`Server berjalan di http://localhost:${PORT}`);
//         console.log('Akses http://localhost:3000/api/start-whatsapp untuk memulai bot.');
//         console.log('Akses http://localhost:3000/api/qr untuk melihat QR code.');
//         console.log('Akses http://localhost:3000/api/status untuk melihat status bot.');
//     });
// }
