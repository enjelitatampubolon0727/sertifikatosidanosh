"use client"

import { useState, useEffect } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

const DriveIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6.5 17h11l2.5-4H9l-2.5 4zm5.5-9L7 13h10l-5-5zm-7 9l2.5-4H2l2.5 4z" />
  </svg>
)

export default function JsonSearch() {
  const [search, setSearch] = useState("")
  const [searchResults, setSearchResults] = useState<[string, string][]>([])
  const [folderData, setFolderData] = useState<Record<string, string>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [showResults, setShowResults] = useState(false)

  useEffect(() => {
    fetch("/api/folder-data")
      .then((res) => res.json())
      .then((data) => setFolderData(data))
      .catch((err) => console.error("Failed to load folder data:", err))
  }, [])

  const handleSearch = () => {
    if (search.trim()) {
      setIsLoading(true)
      setShowResults(false)

      setTimeout(() => {
        const results = Object.entries(folderData).filter(
          ([name]) => name.toLowerCase() === search.toLowerCase().trim(),
        )
        setSearchResults(results)
        setIsLoading(false)
        setShowResults(true)
      }, 500)
    } else {
      setSearchResults([])
      setShowResults(true)
    }
  }

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((word) => word.charAt(0))
      .join("")
      .toUpperCase()
      .slice(0, 2)
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="text-center space-y-3 py-8 animate-fade-in">
        <h1 className="text-4xl font-bold text-gray-900 animate-slide-down">
          Sertifikat Olimpiade Omni Sains Indonesia (OSI) dan Omni Scholar Hero (OSH)
        </h1>
        <p className="text-lg text-gray-600 animate-slide-up">Harap masukkan nama Peserta untuk melanjutkan</p>
      </div>

      <div className="flex gap-2 animate-slide-up">
        <Input
          placeholder="Search names..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="flex-1 transition-all duration-300 focus:scale-105"
        />
        <Button
          type="button"
          onClick={handleSearch}
          disabled={isLoading}
          className="transition-all duration-300 hover:scale-105 active:scale-95"
        >
          {isLoading ? (
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
          ) : (
            "Search"
          )}
        </Button>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 animate-fade-in">
        <h2 className="text-xl font-semibold text-blue-900 mb-4 flex items-center gap-2">
          📋 Cara Mendapatkan Sertifikat Peserta
        </h2>
        <div className="space-y-3 text-blue-800">
          <div className="flex items-start gap-3">
            <span className="bg-blue-200 text-blue-900 rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
              1
            </span>
            <div>
              <p>
                <strong>Masukkan nama lengkap</strong> peserta <strong>seperti</strong> saat{" "}
                <strong>mendaftar olimpiade</strong> (contoh: "Salman Abdillah Utomo")
              </p>
              <div className="mt-2 p-3 bg-yellow-100 border-l-4 border-yellow-400 rounded-r">
                <p className="text-yellow-800 text-sm italic">
                  "Nama peserta yang ditulis <strong>tidak perlu persis sama</strong> dalam hal penggunaan{" "}
                  <strong>huruf besar atau kecil</strong>. Yang terpenting adalah bahwa{" "}
                  <strong>alfabet yang digunakan harus sama</strong> dengan nama yang terdaftar saat{" "}
                  <strong>mendaftar olimpiade</strong>. Contoh: jika nama terdaftar 'Bintang Putra', maka bisa ditulis
                  'bintang Putra', 'BINTANG PUTRA', atau 'bintang putra'."
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="bg-blue-200 text-blue-900 rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
              2
            </span>
            <p>
              <strong>Klik tombol "Search"</strong> atau <strong>tekan Enter</strong> untuk mencari data peserta
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="bg-blue-200 text-blue-900 rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
              3
            </span>
            <div>
              <p>
                <strong>Klik "Open Drive"</strong> untuk membuka folder sertifikat peserta di{" "}
                <strong>Google Drive</strong>
              </p>
              <div className="mt-2 p-2 bg-yellow-100 border-l-4 border-yellow-400 rounded-r">
                <p className="text-yellow-800 text-sm italic">
                  "Pastikan menggunakan <strong>Gmail yang sama</strong> dengan yang digunakan saat mengisi{" "}
                  <strong>GForm claim sertifikat</strong>"
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="bg-blue-200 text-blue-900 rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
              4
            </span>
            <p>
              <strong>Download sertifikat</strong> peserta dari <strong>folder yang terbuka</strong>
            </p>
          </div>
        </div>
        <div className="mt-4 p-3 bg-green-100 border border-green-300 rounded-md">
          <p className="text-green-800 text-sm">
            <strong>💡 Tips:</strong> Jika nama tidak ditemukan, pastikan <strong>ejaan nama lengkap</strong> peserta
            benar dan sesuai dengan <strong>data pendaftaran</strong>.
          </p>
        </div>
      </div>

      {!search.trim() && showResults && (
        <div className="text-center p-6 bg-yellow-50 border border-yellow-200 rounded-lg animate-fade-in">
          <div className="text-yellow-800 font-medium mb-2">⚠️ Peringatan</div>
          <p className="text-yellow-700">
            Silakan masukkan <strong>nama lengkap peserta</strong> untuk mencari sertifikat.
          </p>
        </div>
      )}

      {showResults && search.trim() && searchResults.length === 0 && (
        <div className="text-center p-6 bg-red-50 border border-red-200 rounded-lg animate-fade-in">
          <div className="text-red-800 font-medium mb-2">❌ Tidak Ditemukan</div>
          <p className="text-red-700">
            Nama tidak ditemukan. Pastikan Anda menuliskan <strong>nama lengkap</strong> peserta dengan{" "}
            <strong>benar</strong>.
          </p>
          <p className="text-red-600 text-sm mt-2">
            Contoh: "<strong>Salman Abdillah Utomo</strong>" (bukan hanya "<strong>Abdillah</strong>")
          </p>
        </div>
      )}

      {showResults && searchResults.length > 0 && (
        <div className="grid gap-3 animate-fade-in">
          {searchResults.map(([name, folderId], index) => (
            <Card
              key={`${name}-${folderId}`}
              className="hover:shadow-lg transition-all duration-300 hover:scale-102 animate-slide-up"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-3 mb-3">
                  <Avatar className="transition-transform duration-300 hover:scale-110">
                    <AvatarFallback className="bg-blue-100 text-blue-600">{getInitials(name)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <div className="font-medium">{name}</div>
                    <p className="text-sm text-gray-600 mt-1">
                      Harap membuka folder peserta menggunakan akun gmail yang sama dengan yang digunakan saat mengisi
                      gform claim sertifikat
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => window.open(`https://drive.google.com/drive/u/0/folders/${folderId}`, "_blank")}
                    className="flex items-center gap-2 transition-all duration-300 hover:scale-105 active:scale-95"
                  >
                    <DriveIcon />
                    Open Drive
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
