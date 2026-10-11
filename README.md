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
- Bir odada kullanılan kelime, liste bitene kadar tekrar çıkmaz. Puanlar ve tur geçmişi odada saklanır.

## Dosyalar
| Dosya | İçerik |
|---|---|
| `index.html` | Sayfa ve stiller |
| `app.js` | Oyun mantığı ve Firebase bağlantısı |
| `words.js` | Kelime bankası (Türkçe / Arapça). **Sadece sona ekleme yapılır**, sıra değişmez. |
| `i18n.js` | Arayüz metinleri (TR / AR) |
| `database.rules.json` | Firebase Realtime Database güvenlik kuralları (Firebase konsoluna yapıştırılır) |

Altyapı: GitHub Pages (statik sayfa) + Firebase Realtime Database + Firebase anonim giriş.
