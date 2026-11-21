'use strict';
// Fits every printed page on ONE A4 page. #printRoot holds one .pp box per page (190 x 281 mm inside the 10 mm page margins, overflow hidden, so a page can never spill
// onto another one); the content (.pz) of a page is scaled down with a transform until it fits the height. Pages that are short are not enlarged.
function fitPrintRoot(root) {
  const mm = 96 / 25.4, W = 190 * mm, H = 281 * mm * 0.995; let last = 1;
  for (const pz of root.querySelectorAll('.pp > .pz')) {
    let z = 1;
    for (let i = 0; i < 5; i++) {
      pz.style.transform = ''; pz.style.width = (W / z) + 'px';
      const h = pz.offsetHeight, nz = Math.min(1, H / Math.max(1, h));
      if (Math.abs(nz - z) < 0.002) { z = nz; break; } z = nz;
    }
    pz.style.width = (W / z) + 'px'; pz.style.transformOrigin = '0 0'; pz.style.transform = 'scale(' + z + ')'; last = z;
  }
  return last;
}
if (typeof module !== 'undefined') module.exports = { fitPrintRoot };
