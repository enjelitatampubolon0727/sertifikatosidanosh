import { NextResponse } from "next/server";
import Papa from "papaparse";

export async function GET() {
  try {
    const response = await fetch(
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vSzGJ3VXl5MZ8OKrF5b0ZUVNh4nQxBUjSvSvXiIt4IDOXvrc7Ie6PW4imRnKeFh_1Zh_6kSFH4lph1S/pub?output=csv"
    );

    let csvText = await response.text();

    // 🔹 Bersihkan karakter aneh di awal file (kadang muncul BOM)
    csvText = csvText.replace(/^\uFEFF/, "");

    // 🔹 Hapus baris kosong di atas header (jika ada)
    csvText = csvText.trimStart();

    // 🔹 Parsing CSV
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      quoteChar: '"',
    });

    // 🔹 Validasi: pastikan hasilnya punya kolom yang benar
    if (!parsed.data.length || Object.keys(parsed.data[0]).length <= 1) {
      throw new Error("CSV tidak terbaca dengan benar. Cek header di Google Sheets.");
    }

    return NextResponse.json(parsed.data);
  } catch (error: any) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to fetch or parse CSV", details: error.message },
      { status: 500 }
    );
  }
}
