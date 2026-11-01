// Aplica el tema guardado antes de pintar para evitar parpadeos.
(function () {
  var pref = 'auto';
  try {
    // La app se llamaba «Cuartos»: se conservan las preferencias guardadas con el nombre anterior.
    var old = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('cuartos.') === 0) old.push(k);
    }
    old.forEach(function (k) {
      var nk = 'gastosbyath.' + k.slice(8);
      if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
      localStorage.removeItem(k);
    });
    pref = localStorage.getItem('gastosbyath.theme') || 'auto';
    // Tamaño del texto y vista sencilla de la última vez, antes de pintar nada.
    var fs = localStorage.getItem('gastosbyath.text');
    if (fs) document.documentElement.style.setProperty('--fs', fs);
    if (localStorage.getItem('gastosbyath.simple') === '1') document.documentElement.setAttribute('data-simple', '1');
  } catch (e) {}
  var dark = pref === 'dark' || (pref === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
