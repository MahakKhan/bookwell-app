// Builds a month grid: offset = blank cells before day 1 (Mon-first), days = length,
// sel = selected day, off = days shown struck-through, dots = days with availability.
function cal(id, o) {
  const el = document.getElementById(id);
  let h = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => `<b>${d}</b>`).join("");
  for (let i = 0; i < o.offset; i++) h += "<span></span>";
  for (let d = 1; d <= o.days; d++) {
    const c = d === o.sel ? "sel" : (o.off || []).includes(d) ? "x" : (o.dots || []).includes(d) ? "dot" : "";
    h += `<span class="${c}">${d}</span>`;
  }
  el.innerHTML = h;
}
