const http = require('http');

console.log('Testing root path...');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/',
  method: 'GET'
};

const req = http.request(options, (res) => {
  console.log(`Status Code: ${res.statusCode}`);
  console.log(`Headers: ${JSON.stringify(res.headers)}`);

  let data = '';
  res.on('data', (d) => {
    data += d.toString();
  });
  
  res.on('end', () => {
    console.log('Response length:', data.length);
    if (data.length > 0) {
      console.log('First 500 chars:', data.substring(0, 500));
    }
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.end();
