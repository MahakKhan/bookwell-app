// App icon for the installable team portal (home screen icon).
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4b4bc8"/><stop offset="1" stop-color="#8d6fe0"/></linearGradient></defs>
<rect width="512" height="512" rx="112" fill="url(#g)"/>
<g fill="none" stroke="#fff" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
<rect x="116" y="140" width="280" height="250" rx="42"/><path d="M116 222h280M190 104v66M322 104v66"/></g>
<circle cx="200" cy="290" r="20" fill="#fff"/><circle cx="262" cy="290" r="20" fill="#fff"/></svg>`;

export const loader = () =>
  new Response(SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
