// api/index.js

// Load environment variables from .env file (for local development)
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// --- Konfigurasi dan Inisialisasi Gemini API ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY not found in environment variables!');
    // Penting: Di Vercel, ini akan menjadi fatal jika tidak disetel.
    // Jika tidak ada, bot tidak akan berfungsi dengan AI.
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- Data Produk Sederhana (dari file JSON) ---
let products = [];
try {
    const productsPath = path.resolve(__dirname, '../data/products.json');
    products = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));
    console.log('Produk berhasil dimuat dari data/products.json');
} catch (error) {
    console.error('ERROR: Gagal memuat produk dari data/products.json:', error.message);
}

function searchProduct(query) {
    if (!query) return [];
    const lowerCaseQuery = query.toLowerCase();
    return products.filter(p =>
        p.name.toLowerCase().includes(lowerCaseQuery) ||
        p.description.toLowerCase().includes(lowerCaseQuery)
    );
}

function formatProductList(prods) {
    if (prods.length === 0) {
        return "Maaf, produk yang Anda cari tidak ditemukan.";
    }
    let response = "Berikut adalah produk yang kami temukan:\n\n";
    prods.forEach(p => {
        response += `*${p.name}*\n`;
        response += `Harga: Rp ${p.price.toLocaleString('id-ID')}\n`;
        response += `Stok: ${p.stock}\n`;
        response += `Deskripsi: ${p.description}\n\n`;
    });
    response += "Apakah ada yang ingin Anda tanyakan lagi?";
    return response;
}

// --- Konfigurasi Telegram Bot ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendQrCodeToTelegram(qrCodeText) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('WARNING: Telegram bot token or chat ID not set. Cannot send QR to Telegram.');
        return;
    }
    const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const message = `🚨 *QR Code WhatsApp Baru Dihasilkan!* 🚨\n\n\`\`\`\n${qrCodeText}\n\`\`\`\n\n_Segera Pindai QR Code ini menggunakan aplikasi WhatsApp Anda (Pengaturan > Perangkat Tertaut > Tautkan Perangkat). QR ini hanya berlaku dalam waktu singkat!_`;

    try {
        await axios.post(telegramApiUrl, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('QR Code berhasil dikirim ke Telegram.');
    } catch (error) {
        console.error('ERROR: Gagal mengirim QR Code ke Telegram:', error.response ? error.response.data : error.message);
    }
}

// --- Variabel Global untuk Klien WhatsApp dan Status ---
let client = null; // Inisialisasi sebagai null
let isClientReady = false;
let currentQrCode = null; // Variabel untuk menyimpan QR Code terbaru

// Map untuk menyimpan status sesi per instance fungsi (usaha terbatas di serverless)
// Ini TIDAK akan sepenuhnya persisten antar cold starts atau scale-out
const sessionMap = new Map(); // Untuk menyimpan status 'qr_received', 'ready' per instance fungsi

// Fungsi untuk menginisialisasi klien WhatsApp
// Fungsi ini akan dipanggil saat dibutuhkan
const initializeWhatsappClient = async () => {
    // Hindari inisialisasi ganda jika klien sudah ada atau sedang diproses
    if (client && isClientReady) {
        console.log('Klien WhatsApp sudah siap atau sedang berjalan.');
        return;
    }

    if (sessionMap.get('initializing')) {
        console.log('Klien WhatsApp sudah dalam proses inisialisasi. Tunggu...');
        return;
    }

    sessionMap.set('initializing', true); // Set flag sedang inisialisasi
    console.log('Memulai inisialisasi klien WhatsApp...');

    try {
        client = new Client({
            // LocalAuth akan menyimpan sesi di folder .wwebjs_auth
            // Di Vercel, ini bersifat non-persisten, jadi QR mungkin akan sering diminta
            authStrategy: new LocalAuth({ clientId: 'vercel-whatsapp-bot' }),
            puppeteer: {
                // Konfigurasi Puppeteer untuk lingkungan serverless
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage', // Penting untuk memori di lingkungan terbatas
                    '--single-process',       // Mungkin membantu di lingkungan serverless
                    '--no-zygote'             // Mungkin membantu di lingkungan serverless
                ],
                headless: true // Pastikan ini true untuk headless environment
            }
        });

        client.on('qr', qr => {
            console.log('QR RECEIVED', qr);
            qrcode.generate(qr, { small: true });
            currentQrCode = qr; // Simpan QR Code terbaru
            isClientReady = false; // Klien belum siap, masih butuh QR
            sessionMap.set('qr_received', true); // Set status QR diterima
            sessionMap.set('initializing', false); // Selesai inisialisasi, sekarang menunggu QR
            console.log('QR Code tersedia. Kunjungi /api/qr_display atau kirim ke Telegram.');
        });

        client.on('ready', () => {
            console.log('Client is ready!');
            isClientReady = true;
            currentQrCode = null; // Hapus QR setelah terhubung
            sessionMap.set('qr_received', false);
            sessionMap.set('initializing', false);
            sessionMap.set('client_ready', true);
        });

        client.on('message', async msg => {
            console.log('Pesan Diterima:', msg.body);

            // Abaikan pesan dari bot itu sendiri atau dari status broadcast
            if (msg.fromMe || msg.isStatus) {
                return;
            }

            const lowerCaseBody = msg.body.toLowerCase();

            if (lowerCaseBody.startsWith('!produk ')) {
                const query = msg.body.substring(8).trim();
                const foundProducts = searchProduct(query);
                await msg.reply(formatProductList(foundProducts));
            } else if (lowerCaseBody === '!help') {
                await msg.reply(
                    "👋 Halo! Saya adalah bot toko online Anda.\n\n" +
                    "Anda bisa bertanya tentang produk dengan format: `!produk [nama produk]`\n" +
                    "Contoh: `!produk kemeja`\n\n" +
                    "Untuk pertanyaan umum, Anda bisa langsung ketik pertanyaan Anda, saya akan coba jawab dengan AI.\n" +
                    "Coba tanyakan: `Bagaimana cara merawat sepatu?`"
                );
            } else {
                // Pertanyaan umum, gunakan Gemini AI
                try {
                    const prompt = `Anda adalah asisten AI yang ramah dan informatif untuk toko online. Fokus pada bantuan terkait produk kami atau pertanyaan umum yang relevan. Jika pertanyaan tidak jelas atau terlalu pribadi, Anda bisa menolak dengan sopan.
                    
                    Daftar Produk (untuk referensi, jangan selalu sebutkan semua):
                    - Kemeja Pria Casual: Rp 125.000, stok 50, Kemeja katun berkualitas.
                    - Celana Jeans Slim Fit: Rp 250.000, stok 30, Jeans denim elastis.
                    - Sepatu Sneakers Sporty: Rp 300.000, stok 20, Sepatu ringan dan fleksibel.
                    - Tas Ransel Laptop: Rp 180.000, stok 15, Tas multifungsi.
                    - Jam Tangan Digital: Rp 95.000, stok 40, Jam tangan tahan air.

                    Pertanyaan Pengguna: "${msg.body}"`;

                    const result = await model.generateContent(prompt);
                    const response = await result.response;
                    const text = response.text();
                    await msg.reply(text);
                    console.log('Respons Gemini:', text);
                } catch (error) {
                    console.error('ERROR: Gagal memanggil Gemini API:', error);
                    await msg.reply('Maaf, ada masalah saat memproses permintaan Anda dengan AI. Silakan coba lagi nanti.');
                }
            }
        });

        client.on('disconnected', (reason) => {
            console.log('Client was disconnected', reason);
            isClientReady = false;
            currentQrCode = null; // Sesi putus, QR mungkin diperlukan lagi
            sessionMap.clear(); // Hapus semua status sesi
            // initializeWhatsappClient(); // Hati-hati, ini bisa memicu loop jika terus putus
        });

        await client.initialize();
        console.log('WhatsApp Client initialization process started.');

    } catch (err) {
        console.error('FATAL ERROR: Gagal menginisialisasi WhatsApp Client:', err.message);
        isClientReady = false;
        currentQrCode = null;
        sessionMap.clear();
        // Penting: Jangan terus-menerus mencoba inisialisasi di sini jika gagal,
        // karena bisa menyebabkan Vercel timeout atau loop tak terbatas.
    } finally {
        // sessionMap.delete('initializing'); // Hapus flag setelah proses init selesai
    }
};

// Panggil inisialisasi klien saat aplikasi dimulai (untuk Vercel Cold Start)
// Ini akan memastikan klien mencoba inisialisasi saat fungsi pertama kali aktif
initializeWhatsappClient(); // Panggil sekali saat Vercel instance 'bangun'

// --- Endpoint HTTP untuk Vercel Serverless Function ---

// Endpoint utama (halaman pilihan UI/UX)
app.get('/api', (req, res) => {
    // Vercel akan secara periodik memanggil endpoint ini untuk 'menghidupkan' fungsi.
    // Jika klien belum siap, coba inisialisasi lagi (jika belum dalam proses)
    if (!isClientReady && !sessionMap.get('initializing') && !sessionMap.get('qr_received')) {
        console.log('Client not ready and not initializing. Attempting re-initialization...');
        initializeWhatsappClient();
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp AI Bot - Setup & Status</title>
            <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
            <style>
                body {
                    font-family: 'Poppins', sans-serif;
                    background: linear-gradient(135deg, #6dd5ed, #2193b0);
                    color: #fff;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    margin: 0;
                    padding: 20px;
                    box-sizing: border-box;
                }
                .container {
                    background-color: rgba(255, 255, 255, 0.95);
                    padding: 40px;
                    border-radius: 15px;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                    text-align: center;
                    max-width: 600px;
                    width: 100%;
                    color: #333;
                }
                h1 {
                    font-size: 2.2em;
                    margin-bottom: 20px;
                    color: #2193b0;
                }
                p {
                    font-size: 1.1em;
                    line-height: 1.6;
                    margin-bottom: 25px;
                }
                .status {
                    font-weight: 600;
                    margin-bottom: 20px;
                    padding: 10px;
                    border-radius: 8px;
                    display: inline-block;
                }
                .status.ready {
                    background-color: #28a745;
                    color: white;
                }
                .status.initializing {
                    background-color: #ffc107;
                    color: #333;
                }
                .button-group {
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                    margin-top: 30px;
                }
                .btn {
                    display: block;
                    padding: 15px 25px;
                    font-size: 1.1em;
                    font-weight: 600;
                    border-radius: 8px;
                    text-decoration: none;
                    transition: background-color 0.3s ease, transform 0.2s ease;
                    cursor: pointer;
                    border: none;
                }
                .btn-primary {
                    background-color: #007bff;
                    color: white;
                }
                .btn-primary:hover {
                    background-color: #0056b3;
                    transform: translateY(-2px);
                }
                .btn-secondary {
                    background-color: #6c757d;
                    color: white;
                }
                .btn-secondary:hover {
                    background-color: #545b62;
                    transform: translateY(-2px);
                }
                .note {
                    font-size: 0.9em;
                    color: #666;
                    margin-top: 20px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Selamat Datang di Bot WhatsApp AI Toko Online Anda!</h1>
                <p>Status Bot: <span class="status ${isClientReady ? 'ready' : 'initializing'}">
                    ${isClientReady ? 'Terhubung dan Siap!' : 'Sedang Menginisialisasi...'}
                </span></p>
                <p>Pilih metode untuk mendapatkan QR Code WhatsApp Anda jika bot membutuhkan login ulang:</p>
                
                <div class="button-group">
                    <a href="/api/qr_display" class="btn btn-primary">
                        Tampilkan QR Code di Halaman Ini
                    </a>
                    <button class="btn btn-secondary" onclick="sendQrViaTelegram()">
                        Kirim QR Code ke Telegram Bot
                    </button>
                </div>
                
                <p class="note">
                    <strong>Penting:</strong> Setelah Anda memindai QR, bot akan mulai berjalan. Jika bot putus koneksi, Anda mungkin perlu memicu *deployment* ulang di Vercel atau menunggu hingga bot meminta QR lagi. QR Code hanya berlaku sebentar, jadi segera pindai setelah muncul!
                </p>
            </div>

            <script>
                async function sendQrViaTelegram() {
                    const button = document.querySelector('.btn-secondary');
                    button.disabled = true;
                    button.textContent = 'Mengirim...';
                    try {
                        const response = await fetch('/api/send_qr_to_telegram');
                        const data = await response.json();
                        if (response.ok) {
                            alert(data.message);
                        } else {
                            alert('Gagal mengirim QR ke Telegram: ' + data.error);
                        }
                    } catch (error) {
                        alert('Terjadi kesalahan jaringan: ' + error.message);
                    } finally {
                        button.disabled = false;
                        button.textContent = 'Kirim QR Code ke Telegram Bot';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Endpoint untuk menampilkan QR Code di halaman web
app.get('/api/qr_display', (req, res) => {
    if (currentQrCode) {
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WhatsApp Bot QR Code</title>
                <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
                <style>
                    body {
                        font-family: 'Poppins', sans-serif;
                        background: linear-gradient(135deg, #fbc2eb, #a6c1ee);
                        color: #333;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        margin: 0;
                        padding: 20px;
                        box-sizing: border-box;
                    }
                    .qr-container {
                        background-color: rgba(255, 255, 255, 0.95);
                        padding: 40px;
                        border-radius: 15px;
                        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                        text-align: center;
                        max-width: 500px;
                        width: 100%;
                    }
                    h1 {
                        font-size: 2em;
                        margin-bottom: 15px;
                        color: #8e2de2; /* Warna ungu */
                    }
                    p {
                        font-size: 1.1em;
                        line-height: 1.6;
                        margin-bottom: 25px;
                        color: #555;
                    }
                    pre {
                        font-family: monospace;
                        white-space: pre;
                        background-color: #f8f8f8;
                        padding: 20px;
                        border-radius: 8px;
                        overflow-x: auto;
                        color: #333;
                        font-size: 0.9em;
                        border: 1px dashed #ccc;
                    }
                    .back-btn {
                        display: inline-block;
                        margin-top: 30px;
                        padding: 10px 20px;
                        font-size: 1em;
                        font-weight: 600;
                        background-color: #6c757d;
                        color: white;
                        border-radius: 8px;
                        text-decoration: none;
                        transition: background-color 0.3s ease;
                    }
                    .back-btn:hover {
                        background-color: #545b62;
                    }
                </style>
            </head>
            <body>
                <div class="qr-container">
                    <h1>Pindai QR Code WhatsApp Anda</h1>
                    <p>Gunakan aplikasi WhatsApp di ponsel Anda: Pengaturan > Perangkat Tertaut > Tautkan Perangkat.</p>
                    <p>QR Code ini akan *refresh* jika bot meminta yang baru. Segera pindai!</p>
                    <pre>${currentQrCode}</pre>
                    <p>Jika QR Code tidak muncul, pastikan bot sedang meminta QR atau refresh halaman ini.</p>
                    <a href="/api" class="back-btn">Kembali ke Pilihan</a>
                </div>
            </body>
            </html>
        `);
    } else {
        res.status(200).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WhatsApp Bot QR Code - Not Available</title>
                <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
                <style>
                    body {
                        font-family: 'Poppins', sans-serif;
                        background: linear-gradient(135deg, #fbc2eb, #a6c1ee);
                        color: #333;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        margin: 0;
                        padding: 20px;
                        box-sizing: border-box;
                    }
                    .message-container {
                        background-color: rgba(255, 255, 255, 0.95);
                        padding: 40px;
                        border-radius: 15px;
                        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                        text-align: center;
                        max-width: 500px;
                        width: 100%;
                    }
                    h1 {
                        font-size: 2em;
                        margin-bottom: 15px;
                        color: #e74c3c; /* Warna merah */
                    }
                    p {
                        font-size: 1.1em;
                        line-height: 1.6;
                        margin-bottom: 25px;
                        color: #555;
                    }
                    .back-btn {
                        display: inline-block;
                        margin-top: 30px;
                        padding: 10px 20px;
                        font-size: 1em;
                        font-weight: 600;
                        background-color: #6c757d;
                        color: white;
                        border-radius: 8px;
                        text-decoration: none;
                        transition: background-color 0.3s ease;
                    }
                    .back-btn:hover {
                        background-color: #545b62;
                    }
                </style>
            </head>
            <body>
                <div class="message-container">
                    <h1>QR Code Belum Tersedia</h1>
                    <p>Bot WhatsApp mungkin sedang dalam proses inisialisasi, sudah terhubung, atau sesi terputus.</p>
                    <p>Silakan kembali ke halaman utama dan pilih opsi 'Kirim QR Code ke Telegram Bot' untuk notifikasi instan, atau tunggu sebentar dan coba *refresh* halaman ini.</p>
                    <a href="/api" class="back-btn">Kembali ke Pilihan</a>
                </div>
            </body>
            </html>
        `);
    }
});

// Endpoint untuk memicu pengiriman QR ke Telegram
app.get('/api/send_qr_to_telegram', async (req, res) => {
    if (currentQrCode) {
        try {
            await sendQrCodeToTelegram(currentQrCode);
            res.json({ success: true, message: 'QR Code berhasil dikirim ke Telegram Anda!' });
        } catch (error) {
            console.error('ERROR: Gagal mengirim QR dari endpoint:', error);
            res.status(500).json({ success: false, error: 'Gagal mengirim QR Code ke Telegram.' });
        }
    } else {
        res.status(404).json({ success: false, error: 'QR Code belum tersedia atau bot sudah terhubung.' });
    }
});


// Export the app for Vercel
module.exports = app;
