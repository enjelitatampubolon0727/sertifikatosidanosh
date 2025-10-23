# Dokumentasi Codebase: Aplikasi Pencarian Sertifikat

## Overview
Aplikasi ini adalah web app Next.js yang berfungsi untuk mencari sertifikat peserta berdasarkan nama. Aplikasi menyediakan antarmuka pencarian yang sederhana dengan integrasi Google Drive untuk akses langsung ke folder sertifikat masing-masing peserta.

## Struktur Proyek
- **Framework**: Next.js 14 dengan App Router
- **Language**: TypeScript
- **UI Library**: shadcn/ui + Radix UI components
- **Styling**: Tailwind CSS
- **Theme**: next-themes untuk dark/light mode
- **Deployment**: Vercel

## Struktur Direktori
```
├── app/
│   ├── page.tsx              # Halaman utama (komponen JsonSearch)
│   ├── layout.tsx            # Layout global
│   ├── globals.css           # CSS global
│   └── api/
│       └── folder-data/route.ts    # Public API endpoint untuk pencarian
├── components/
│   ├── ui/                   # Komponen shadcn/ui
│   └── theme-provider.tsx    # Provider tema
├── lib/
│   ├── utils.ts              # Utilitas (cn function)
│   └── types/                # TypeScript type definitions
├── public/                   # Assets statis
├── styles/                   # CSS tambahan
├── folder-mapping.json       # Database static (nama -> folder ID)
├── .env                      # Environment configuration
└── .env.example              # Environment template
```

## Fungsionalitas Saat Ini

### 1. Pencarian Nama
- Input field untuk memasukkan nama
- Pencarian case-insensitive
- Filtering real-time dari data JSON
- Tampilan hasil dalam bentuk card

### 2. Akses Google Drive
- Static mapping nama -> Google Drive folder ID
- Tombol "Open Drive" yang membuka folder di tab baru
- URL format: `https://drive.google.com/drive/u/0/folders/{folderId}`

### 3. Data Flow
1. Frontend fetch data dari `/api/folder-data`
2. API membaca `folder-mapping.json`
3. Data disimpan di React state
4. Pencarian dilakukan client-side filtering
5. Hasil ditampilkan sebagai cards
6. Link langsung ke Google Drive folder

## Dependencies Utama

### Frontend
- **next**: Framework React
- **react**: UI library
- **tailwindcss**: CSS framework
- **@radix-ui/***: Headless UI components
- **lucide-react**: Icons
- **next-themes**: Theme management

### Backend (Dependencies)
- **googleapis**: Google Drive & Sheets API integration (untuk data sourcing)

## Aplikasi Pencarian Sertifikat Sederhana

Aplikasi ini adalah aplikasi pencarian sederhana yang:
- **Membaca data statis** dari `folder-mapping.json`
- **Menyediakan API publik** di `/api/folder-data`
- **Menampilkan hasil pencarian** dengan link Google Drive
- **Fokus pada fungsionalitas pencarian saja**

### Catatan:
- Aplikasi menggunakan data mapping yang sudah ada
- Interface pencarian yang sederhana dan responsif
- Tidak ada background processing atau admin panel

## Setup dan Installation

### 1. Environment Configuration
```env
# Aplikasi pencarian tidak memerlukan environment variables khusus
# Semua data sudah ada dalam folder-mapping.json
```

### 2. Running the Application
```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Production mode
npm run build && npm start
```


## File-file Penting
- `folder-mapping.json`: Static mapping data (392KB)
- `app/page.tsx`: Main component dengan search logic
- `app/api/folder-data/route.ts`: API endpoint
- `.env`: Environment variables (perlu disetup)

## Notes
- Codebase sudah cukup solid dengan TypeScript dan modern React patterns
- UI framework (shadcn/ui) sudah siap untuk expansion
- Aplikasi fokus pada fungsionalitas pencarian sertifikat saja
- Perlu ditambahkan Google API credentials dan environment setup
