// Load environment variables from .env file (for local development)
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs'); // For reading local product data
const path = require('path');

const app = express();
app.use(bodyParser.json());

// --- Konfigurasi dan Inisialisasi Gemini API ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not found in environment variables!');
    // In a production Vercel environment, this check is crucial.
    // For local testing, ensure your .env file is correctly set.
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
    console.error('Gagal memuat produk dari data/products.json:', error.message);
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

// --- Inisialisasi WhatsApp Client ---
// CATATAN: whatsapp-web.js sulit dijalankan terus menerus di lingkungan serverless
// seperti Vercel tanpa stateful storage. Pendekatan ini akan mencoba inisialisasi
// setiap kali fungsi dipanggil, yang TIDAK efisien dan berisiko putus koneksi.
// Untuk produksi, pertimbangkan server dedicated.

let client;
let isClientReady = false; // Flag untuk melacak status kesiapan klien

// Fungsi untuk menginisialisasi klien WhatsApp
const initializeWhatsappClient = () => {
    if (client && isClientReady) {
        console.log('Klien WhatsApp sudah siap dan berjalan.');
        return;
    }

    console.log('Menginisialisasi klien WhatsApp...');
    client = new Client({
        authStrategy: new LocalAuth(), // Menyimpan sesi secara lokal
        puppeteer: {
            // Argumen ini penting untuk menjalankan Puppeteer di lingkungan serverless
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });

    client.on('qr', qr => {
        console.log('QR RECEIVED', qr);
        qrcode.generate(qr, { small: true });
        // Anda perlu memindai QR ini dari konsol Vercel saat deployment pertama kali
        // atau saat sesi terputus. Ini adalah tantangan utama di Vercel.
    });

    client.on('ready', () => {
        console.log('Client is ready!');
        isClientReady = true;
    });

    client.on('message', async msg => {
        console.log('Pesan Diterima:', msg.body);

        if (msg.body.startsWith('!produk ')) {
            const query = msg.body.substring(8); // Ambil query setelah "!produk "
            const foundProducts = searchProduct(query);
            await msg.reply(formatProductList(foundProducts));
        } else if (msg.body === '!help') {
            await msg.reply(
                "Halo! Saya adalah bot toko online.\n" +
                "Anda bisa bertanya tentang produk dengan format: `!produk [nama produk]`\n" +
                "Contoh: `!produk kemeja`\n" +
                "Untuk pertanyaan umum, Anda bisa langsung ketik pertanyaan Anda, saya akan coba jawab dengan AI."
            );
        } else if (msg.fromMe) {
            // Ignore messages sent by the bot itself
            return;
        } else {
            // Pertanyaan umum, gunakan Gemini AI
            try {
                // Berikan konteks ke Gemini
                const prompt = `Anda adalah asisten AI untuk toko online. Jawab pertanyaan pengguna dengan ramah dan informatif. Jika pertanyaan tidak terkait produk, jawab dengan pengetahuan umum.
                Pengguna: "${msg.body}"`;

                const result = await model.generateContent(prompt);
                const response = await result.response;
                const text = response.text();
                await msg.reply(text);
                console.log('Respons Gemini:', text);
            } catch (error) {
                console.error('Gagal memanggil Gemini API:', error);
                await msg.reply('Maaf, ada masalah saat memproses permintaan Anda dengan AI. Silakan coba lagi nanti.');
            }
        }
    });

    client.on('disconnected', (reason) => {
        console.log('Client was disconnected', reason);
        isClientReady = false;
        // Mungkin perlu mencoba inisialisasi ulang jika terputus
        // initializeWhatsappClient();
    });

    client.initialize().catch(err => {
        console.error('Gagal menginisialisasi WhatsApp Client:', err);
        isClientReady = false;
    });
};

// Panggil inisialisasi klien saat pertama kali modul dimuat
// initializeWhatsappClient(); // Ini akan memicu inisialisasi saat Vercel function mulai

// --- Endpoint HTTP untuk Vercel Serverless Function ---
// Vercel akan memanggil fungsi ini saat ada request HTTP.
// Karena sifat serverless, Anda mungkin perlu memicu inisialisasi atau
// memastikan klien WA sudah siap di sini.
app.get('/api', (req, res) => {
    // Vercel akan secara periodik "menghidupkan" fungsi ini.
    // Jika klien belum siap, coba inisialisasi.
    if (!isClientReady) {
        initializeWhatsappClient(); // Coba inisialisasi ulang jika belum siap
        return res.status(200).send('WhatsApp client is initializing. Please check logs for QR code scan if needed.');
    }
    res.status(200).send('WhatsApp bot is running and ready. Send messages to your bot account.');
});

// Anda mungkin perlu endpoint lain jika ingin memicu sesuatu dari luar,
// tapi untuk bot yang merespons pesan WhatsApp, ini tidak terlalu relevan.

// Export the app for Vercel
module.exports = app;
