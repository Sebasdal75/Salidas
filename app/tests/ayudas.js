'use strict';
// Guías 1Z válidas para las pruebas: se calcula el dígito de control.
const MAPA = { A: 2, B: 3, C: 4, D: 5, E: 6, F: 7, G: 8, H: 9, I: 0, J: 1, K: 2, L: 3, M: 4, N: 5, O: 6, P: 7, Q: 8, R: 9,
               S: 0, T: 1, U: 2, V: 3, W: 4, X: 5, Y: 6, Z: 7 };
function guia(n) {
  const base = ('999AA1' + String(n).padStart(9, '0')).substring(0, 15);
  let imp = 0, par = 0;
  for (let i = 0; i < 15; i++) {
    const c = base[i];
    const v = (c >= '0' && c <= '9') ? Number(c) : MAPA[c];
    if (i % 2 === 0) imp += v; else par += v;
  }
  return '1Z' + base + ((10 - ((imp + par * 2) % 10)) % 10);
}
const col = (...v) => v.map(x => (typeof x === 'string' ? { valor: x } : x));
module.exports = { guia, col };
