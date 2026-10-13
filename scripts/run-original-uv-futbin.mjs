// Run the ORIGINAL UV application with FUTBIN as the only console price source.
// Keeps the original layout and allocator; FUTBIN-only lists have isolated storage.
// Starts the existing UV app with the direct FUTBIN provider only.
import express from 'express';

process.env.UV_PRICE_SOURCE = 'FUTBIN_ONLY';
process.env.GAME_YEAR = '27';

const { uvRouter } = await import('../uv/uvApp.js');
const port = Number(process.env.ORIGINAL_UV_FUTBIN_PORT || 5188);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Invalid ORIGINAL_UV_FUTBIN_PORT');
}
const app = express();
app.get('/', (_req, res) => res.redirect('/uv/'));
app.use(uvRouter);
app.listen(port, '127.0.0.1', () => {
  console.log('Original FC ÜV Brain (FUTBIN-only prices) läuft auf http://127.0.0.1:' + port + '/uv/');
  console.log('Bestehendes ÜV-Design und Budgetverteilung; FUTBIN FC27 PS als einzige Preisquelle.');
  console.log('Budgetliste und Filter aktiv. Games/Sales derzeit nicht verfügbar; keine Kauf-Freigabe.');
});
