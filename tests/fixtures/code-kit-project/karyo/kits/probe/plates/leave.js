// A test kit's script: it navigates its own frame away, out of its content security policy.
// Karyo notices the frame's second load, removes it and says so on the plate.
export function render(host) {
  host.textContent = 'leaving…';
  setTimeout(() => { location.href = 'about:blank#left'; }, 50);
}
