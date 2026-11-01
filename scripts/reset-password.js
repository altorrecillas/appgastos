// Restablece la contraseña de un usuario desde la terminal del servidor.
// Uso: npm run reset-password -- <usuario> [nueva-contraseña]
import readline from 'node:readline/promises';
import { one, run } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const [username, given] = process.argv.slice(2);
if (!username) {
  console.log('Uso: npm run reset-password -- <usuario> [nueva-contraseña]');
  console.log('Usuarios:', (await import('../src/db.js')).all('SELECT username FROM users ORDER BY id').map((u) => u.username).join(', ') || '(ninguno)');
  process.exit(1);
}
const user = one('SELECT id, display_name FROM users WHERE username = ?', username);
if (!user) {
  console.error(`No existe el usuario «${username}».`);
  process.exit(1);
}
let password = given;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question(`Nueva contraseña para ${user.display_name}: `);
  rl.close();
}
if (!password || password.length < 8) {
  console.error('La contraseña debe tener al menos 8 caracteres.');
  process.exit(1);
}
run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), user.id);
run('DELETE FROM sessions WHERE user_id = ?', user.id);
console.log(`Contraseña de «${username}» cambiada. Se han cerrado sus sesiones abiertas.`);
process.exit(0);
