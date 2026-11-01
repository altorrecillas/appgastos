// Un «cable» entre el navegador y el servidor de pruebas que se puede cortar, para probar la app sin conexión:
// «up» deja pasar, «down» corta cada conexión nada más abrirse (como un servidor apagado) y «hang» la acepta y no
// contesta nunca (como Tailscale sin ruta hasta el servidor: ni falla ni responde).
// Escucha en «localhost» porque el navegador solo deja instalar el service worker con HTTPS o en localhost.
import net from 'node:net';

export async function startProxy(target) {
  const { hostname, port } = new URL(target);
  let mode = 'up';
  const open = new Set();
  const track = (s) => {
    open.add(s);
    s.on('close', () => open.delete(s));
    s.on('error', () => {});
  };
  const server = net.createServer((client) => {
    track(client);
    if (mode === 'down') return client.destroy();
    if (mode === 'hang') return;
    const upstream = net.connect(Number(port), hostname);
    track(upstream);
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://localhost:${server.address().port}`,
    // Al cambiar, se cortan también las conexiones abiertas (el navegador las reutiliza).
    set(m) {
      mode = m;
      for (const s of open) s.destroy();
    },
    close: () => new Promise((resolve) => {
      for (const s of open) s.destroy();
      server.close(resolve);
    }),
  };
}
