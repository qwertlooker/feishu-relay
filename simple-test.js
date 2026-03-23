const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  console.log('Health check requested');
  res.json({ ok: true, message: 'Server is running!' });
});

app.get('/', (req, res) => {
  console.log('Root path requested');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Simple test server running at http://localhost:${PORT}`);
  console.log('Testing path:', path.join(__dirname, 'public', 'index.html'));
});
