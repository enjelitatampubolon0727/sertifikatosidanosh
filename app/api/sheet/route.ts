import { NextResponse } from "next/server";

export async function GET() {
  try {
    const response = await fetch(
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vSzGJ3VXl5MZ8OKrF5b0ZUVNh4nQxBUjSvSvXiIt4IDOXvrc7Ie6PW4imRnKeFh_1Zh_6kSFH4lph1S/pub?output=csv"
    );

    const csvText = await response.text();
    const rows = csvText.trim().split("\n");
    const headers = rows[0].split(",");

    const data = rows.slice(1).map((row) => {
      const values = row.split(",");
      const obj: Record<string, string> = {};
      headers.forEach((header, index) => {
        obj[header.trim()] = values[index]?.trim() || "";
      });
      return obj;
    });

    return NextResponse.json(data);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to fetch data" }, { status: 500 });
  }
}
