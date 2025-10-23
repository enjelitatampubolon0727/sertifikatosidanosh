import { NextResponse } from "next/server";
import Papa from "papaparse";

export async function GET() {
  try {
    const response = await fetch(
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vSzGJ3VXl5MZ8OKrF5b0ZUVNh4nQxBUjSvSvXiIt4IDOXvrc7Ie6PW4imRnKeFh_1Zh_6kSFH4lph1S/pub?output=csv"
    );

    const csvText = await response.text();

    // Gunakan papaparse agar parsing lebih akurat
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    return NextResponse.json(parsed.data);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to fetch data" },
      { status: 500 }
    );
  }
}
