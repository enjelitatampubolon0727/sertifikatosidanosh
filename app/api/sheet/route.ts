import { NextResponse } from "next/server";
import Papa from "papaparse";

// Ganti link di bawah ini dengan semua link CSV dari sheet yang kamu publish
const SHEET_URLS = [
  "https://docs.google.com/spreadsheets/d/e/2PACX-AAA/pub?output=csv",
  "https://docs.google.com/spreadsheets/d/e/2PACX-BBB/pub?output=csv",
  "https://docs.google.com/spreadsheets/d/e/2PACX-CCC/pub?output=csv",
];

export async function GET() {
  try {
    // Ambil semua CSV sekaligus
    const results = await Promise.all(
      SHEET_URLS.map(async (url) => {
        const res = await fetch(url);
        let csv = await res.text();

        // Bersihkan CSV agar tidak error parsing
        csv = csv.replace(/^\uFEFF/, "").trim();

        const parsed = Papa.parse(csv, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: true,
        });

        return parsed.data;
      })
    );

    // Gabungkan semua hasil
    const allData = results.flat();

    return NextResponse.json(allData);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Gagal mengambil data dari salah satu sheet", details: error.message },
      { status: 500 }
    );
  }
}
