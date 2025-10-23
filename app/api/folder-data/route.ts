import { NextResponse } from "next/server"
import folderData from "../../../folder-mapping.json"

export async function GET() {
  try {
    return NextResponse.json(folderData)
  } catch (error) {
    console.error("API Error:", error)
    return NextResponse.json({ error: "Failed to load folder data" }, { status: 500 })
  }
}
