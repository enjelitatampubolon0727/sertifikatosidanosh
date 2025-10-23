import { NextResponse } from "next/server";
import Papa from "papaparse";

export async function GET() {
  try {
    const response = await fetch(
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vSzGJ3VXl5MZ8OKrF5b0ZUVNh4nQxBUjSvSvXiIt4IDOXvrc7Ie6PW4imRnKeFh_1Zh_6kSFH4lph1S/pub?output=csv",
      { cache: "no-store" }
    );

    const csvText = await response.text();

    // Hapus baris kosong di awal atau tanda kutip yang mengganggu
    const cleanedCsv = csvText
      .split("\n")
      .filter((row) => row.trim() !== "")
      .join("\n")
      .replace(/""/g, '"'); // bersihkan kutip ganda

    const parsed = Papa.parse(cleanedCsv, {
      header: true,
      skipEmptyLines: true,
    });

    // Bersihkan data (hapus kolom kosong)
    const cleanData = parsed.data.map((row) => {
      const cleanedRow: Record<string, string> = {};
      for (const key in row) {
        if (key && key.trim() !== "") {
          cleanedRow[key.trim()] = (row[key] || "").trim();
        }
      }
      return cleanedRow;
    });

    return NextResponse.json(cleanData);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to fetch data" }, { status: 500 });
  }
}
