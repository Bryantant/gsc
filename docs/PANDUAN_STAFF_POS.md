# Panduan Staff: Menggunakan POS — The G Shoe Care

Panduan ini menjelaskan cara pakai layar POS (Point of Sale) di ERPNext, termasuk fitur-fitur khusus yang dibuat untuk The G Shoe Care (tombol Buat Pelanggan Baru, Kirim Struk WhatsApp, dan status pengerjaan laundry di Recent Orders).

## Daftar Isi
1. Membuka Halaman POS
2. Buka Kasir (Opening Entry)
3. Mengenal Layar POS
4. Menambahkan Pelanggan Baru
5. Menambahkan Item ke Keranjang
6. Checkout & Memilih Metode Pembayaran
7. Mengirim Struk via WhatsApp
8. Recent Orders & Status Pengerjaan Laundry
9. Fitur Lainnya
10. Tutup Kasir (Closing Entry)
11. Tips & Hal yang Sering Salah

---

## 1. Membuka Halaman POS
1. Buka browser, masuk ke alamat toko lalu tambahkan `/app/point-of-sale`.
2. Login dengan akun karyawan masing-masing.
3. Jika akun kamu terhubung ke lebih dari satu POS Profile (mis. profil outlet utama vs profil testing), sistem akan meminta kamu memilih salah satu sebelum kasir terbuka. Pilih sesuai outlet/shift kamu.

## 2. Buka Kasir (Opening Entry)
1. Pertama kali membuka POS di awal shift, muncul dialog **Create POS Opening Entry**.
2. Isi **Opening Amount** (saldo kas awal) untuk tiap metode pembayaran yang tersedia (Cash / QRIS).
3. Klik **Submit**.

> Jika muncul peringatan **Outdated POS Opening Entry**, artinya ada shift sebelumnya yang belum ditutup dengan benar. Jangan asal lanjut — laporkan ke supervisor dulu.

## 3. Mengenal Layar POS
- **Kiri**: daftar/grid item. Cari item lewat kotak pencarian di atas, atau pilih per grup (Shoes, Helm, Topi, Tas, dll).
- **Kanan**: keranjang (cart) — field pelanggan di atas, daftar item yang dipilih di tengah, total di bawah.
- Klik/tap sebuah item untuk memasukkannya ke keranjang; ubah jumlah (qty) langsung dari baris item di keranjang.

## 4. Menambahkan Pelanggan Baru
1. Field **Customer** ada di atas keranjang — ketik nama atau no. HP untuk mencari pelanggan yang sudah ada.
2. Untuk pelanggan baru, klik tombol **+** kecil di sebelah field Customer.
3. Isi **Nama** dan **No. HP** pelanggan lalu simpan.

> **No. HP wajib diisi dengan benar.** Nomor ini yang dipakai sistem untuk mengirim struk lewat WhatsApp (lihat bagian 7). Pelanggan tanpa no. HP valid tidak bisa dikirimkan struk WA.

Pelanggan baru otomatis terpilih di transaksi yang sedang berjalan.

## 5. Menambahkan Item ke Keranjang
- Klik/tap item dari grid di kiri untuk menambahkannya ke keranjang.
- Item dari grup **Services** (Shoes, Helm, Topi, Tas) adalah item jasa cuci. Begitu transaksi ini disubmit, sistem **otomatis membuat Laundry Order** untuk melacak proses pengerjaannya (lihat bagian 8).
- Atur jumlah (qty) langsung di baris item pada keranjang.

## 6. Checkout & Memilih Metode Pembayaran
1. Klik tombol **Checkout** di bagian bawah keranjang.
2. Di layar **Payment Method**, pilih metode pembayaran yang dipakai pelanggan: **Cash** atau **QRIS** (sesuai yang aktif di POS Profile kasir kamu).
3. Masukkan jumlah uang yang diterima — jika Cash, sistem otomatis menghitung kembalian (**Change Amount**).
4. Klik **Complete Order**.

Transaksi langsung submit dan lunas saat itu juga — bisnis ini menerapkan bayar penuh di depan (drop-off), karena barang baru selesai dikerjakan 3–4 hari kemudian.

## 7. Mengirim Struk via WhatsApp
1. Setelah **Complete Order**, layar ringkasan pesanan (order summary) muncul dengan tombol ungu **WhatsApp Receipt**.
2. Klik tombol tersebut. WhatsApp (aplikasi atau WhatsApp Web) otomatis terbuka ke nomor pelanggan, dengan pesan dan link PDF struk sudah terisi otomatis.
3. Tinggal klik **Send** di WhatsApp.

Catatan:
- Link struk PDF berlaku selama **30 hari**. Kalau pelanggan minta struk lagi setelah itu, klik ulang saja tombol **WhatsApp Receipt** — sistem otomatis membuatkan link baru.
- Kalau no. HP pelanggan kosong atau tidak valid, sistem akan menampilkan pesan error yang menyebutkan nama pelanggan mana yang datanya perlu diperbaiki. Perbaiki dulu di data Customer, baru coba kirim lagi.
- Tombol **Print Receipt** dan **Email Receipt** sudah tidak dipakai di sini (disembunyikan) — semua struk dikirim lewat WhatsApp.

## 8. Recent Orders & Status Pengerjaan Laundry
1. Klik tombol **Recent Orders** di kanan atas untuk melihat pesanan-pesanan sebelumnya.
2. Cari pesanan lama berdasarkan nama pelanggan atau nomor invoice.
3. Gunakan filter status untuk mempersempit daftar: **Draft, Paid, Fulfillment Pending, Return, Partly Paid**.
   - **Fulfillment Pending** = pesanan yang proses cuciannya **belum selesai** (Laundry Order belum berstatus Completed). Gunakan filter ini untuk cek apa saja yang masih perlu dikerjakan atau diambil pelanggan.
4. Klik salah satu pesanan untuk melihat ringkasannya.
5. Untuk pesanan yang berisi item jasa cuci, akan muncul dropdown **Fulfillment Status** — update sesuai progres:
   - **In Progress** — sedang dikerjakan.
   - **Ready to Collect** — sudah selesai, siap diambil pelanggan.
   - **Completed** — sudah diserahkan/diambil pelanggan.

   Perubahan status tersimpan otomatis (muncul notifikasi hijau *Fulfillment Status updated*).
6. Tombol **WhatsApp Receipt** juga tersedia di sini kalau pelanggan minta struknya dikirim ulang. (Catatan: tombol ini hanya muncul untuk pesanan yang **bukan** berstatus Draft.)

## 9. Fitur Lainnya
- **Edit Order / Delete Order** — hanya untuk pesanan berstatus **Draft** (belum disubmit), misalnya ada kesalahan sebelum transaksi selesai.
- **Return** — untuk memproses pengembalian barang dari transaksi yang sudah lunas.
- **Open in Form View** — membuka dokumen invoice lengkap di layar desk, biasanya untuk kebutuhan detail/lanjutan oleh admin atau supervisor.
- **New Invoice / New Order** — memulai transaksi baru.
- Menu titik tiga (⋮) di kanan atas berisi **Open Form View** (`Ctrl+F`) dan **Close the POS** (`Shift+Ctrl+C`, lihat bagian 10).

## 10. Tutup Kasir (Closing Entry)
1. Di akhir shift, buka menu titik tiga (⋮) lalu pilih **Close the POS**.
2. Sistem membuka form **POS Closing Entry** berisi ringkasan transaksi per metode pembayaran selama shift berjalan.
3. Hitung uang kas fisik, isi jumlah closing sesuai kondisi nyata, lalu cocokkan dengan angka sistem.
4. Kalau ada selisih, catat di kolom yang tersedia dan laporkan ke supervisor.
5. Submit — shift resmi ditutup. Kasir berikutnya baru bisa membuka Opening Entry baru setelah ini.

## 11. Tips & Hal yang Sering Salah
- Selalu lengkapi no. HP pelanggan saat membuat customer baru — kalau tidak, struk WhatsApp tidak bisa dikirim nanti.
- Laundry Order hanya otomatis dibuat untuk item dari grup **Services** (Shoes, Helm, Topi, Tas). Item lain (kalau ada, mis. retail) tidak akan memunculkan Laundry Order — ini normal, bukan bug.
- Jangan lupa update **Fulfillment Status** di Recent Orders begitu progres cucian berubah, supaya rekan lain juga tahu statusnya lewat filter **Fulfillment Pending**.
- Kalau lupa/gagal tutup kasir shift sebelumnya (muncul peringatan Outdated POS Opening Entry), jangan asal buka baru — cek dulu dengan supervisor.
- Tombol WhatsApp Receipt hanya muncul untuk pesanan yang sudah disubmit (bukan Draft).

---
*Dokumen ini disusun berdasarkan konfigurasi POS aktif di situs gsc.localhost (kustomisasi app `gsc`, per Agustus 2026). Update panduan ini kalau ada perubahan konfigurasi POS di kemudian hari.*
