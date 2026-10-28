/* Keep the neutral silhouette visible when an external GitHub avatar is unavailable. */
(function () {
  function fallback(image) { image.setAttribute('data-failed', ''); }
  document.querySelectorAll('.hunter-avatar img').forEach(function (image) {
    image.addEventListener('error', function () { fallback(image); });
    if (image.complete && !image.naturalWidth) fallback(image);
  });
}());
