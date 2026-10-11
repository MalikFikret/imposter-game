# Sahtekâr · المحتال

Arkadaşlarla oynanan kelime ve blöf oyunu. Herkes gizli kelimeyi bilir, sahtekâr bilmez.

**Oyna:** https://malikfikret.github.io/imposter-game/

## Modlar
- **Online oda:** Herkes kendi telefonundan katılır (6 haneli kod ya da davet linki), kendi kartını görür, oyunu telefondan onaylayarak verir.
- **Tek telefon odası:** Telefon elden ele dolaşır, oylama konuşarak yapılır ve sonuç telefonda işaretlenir.

## Kurallar
- Kartlar herkeste aynı görünür. Sahtekârın kartında kelime yerine "Sahtekârsın" yazar.
- Konuşma sırası rastgeledir. Sahtekârın ilk konuşan olma ihtimali düşüktür (~%5).
- Oylar eşit çıkarsa herkes bir ipucu daha söyler ve tekrar oylanır.
- Yakalanan sahtekârın kelimeyi tahmin etmek için 1 dakikası vardır. Sonra diğer oyuncular "bildi / bilemedi" diye oylar.
- Puanlar: ekip kazanırsa ekipteki herkese +1, sahtekâr kazanırsa sahtekâra +2.
- Odalar özel (sadece kodla) ya da açık (ana menüde listelenir) olabilir.
- Oda sahibi 6 haneli oda PIN'iyle başka cihazdan geri dönebilir; oyuncular 4 haneli kişisel PIN'le.
- Bir odada kullanılan kelime, liste bitene kadar tekrar çıkmaz. Puanlar ve tur geçmişi odada saklanır.

## Dosyalar
| Dosya | İçerik |
|---|---|
| `index.html` | Sayfa ve stiller |
| `app.js` | Oyun mantığı ve Firebase bağlantısı |
| `words.js` | Kelime bankası, her kelime `Türkçe|Arapça|İngilizce`. **Sadece sona ekleme yapılır**, sıra değişmez. |
| `i18n.js` | Dil listesi (`LANGS`) ve arayüz metinleri (TR / AR / EN) |
| `admin.html`, `admin.js` | Yönetim paneli (Google girişi, sadece kurallarda tanımlı admin hesabı) |
| `style.css` | Ortak stiller |
| `database.rules.json` | Firebase Realtime Database güvenlik kuralları (Firebase konsoluna yapıştırılır) |

Altyapı: GitHub Pages (statik sayfa) + Firebase Realtime Database + Firebase anonim giriş.

## Yeni dil eklemek
1. `i18n.js` içinde `LANGS` listesine dili ekle (kod, ad, yön).
2. Aynı dosyada `STR` içine o dilin metin bloğunu ekle.
3. `words.js` içinde her kategoriye o dilde ad ekle ve her kelimeye sona bir `|çeviri` sütunu ekle.
