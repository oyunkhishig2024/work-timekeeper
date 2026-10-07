# Fonts

`DejaVuSans.ttf` and `DejaVuSans-Bold.ttf` (DejaVu fonts, Bitstream Vera licence — see
`LICENSE-DejaVu.txt`) are embedded in generated PDFs (consent forms). They cover the full Cyrillic
range including the Mongolian letters Ү ү Ө ө. They can be replaced by another font with the same
coverage (for example Noto Sans) by changing `FONT_REGULAR` / `FONT_BOLD` in `src/consent/pdf.ts`.
