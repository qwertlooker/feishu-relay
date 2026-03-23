const http = require('http');

console.log('Testing server...');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/health',
  method: 'GET'
};

const req = http.request(options, (res) => {
  console.log(`Status Code: ${res.statusCode}`);
  console.log(`Headers: ${JSON.stringify(res.headers)}`);

  res.on('data', (d) => {
    process.stdout.write('Response: ' + d.toString() + '\n');
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.end();
