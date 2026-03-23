const http = require('http');

const chatId = 'oc_237c18e6a47a62a377f20bfb791fc703';
const testMessage = '🤖 你好！这是来自服务器的测试消息！';

console.log('=== 测试发送消息到飞书 ===');
console.log('Chat ID:', chatId);
console.log('消息:', testMessage);
console.log('');

const postData = JSON.stringify({
  chatId: chatId,
  message: testMessage
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/send',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

const req = http.request(options, (res) => {
  console.log(`状态码: ${res.statusCode}`);
  
  let data = '';
  res.on('data', (d) => {
    data += d.toString();
  });
  
  res.on('end', () => {
    console.log('');
    console.log('响应:');
    try {
      const jsonData = JSON.parse(data);
      console.log(JSON.stringify(jsonData, null, 2));
    } catch {
      console.log(data);
    }
  });
});

req.on('error', (error) => {
  console.error('发送失败:', error);
});

req.write(postData);
req.end();
