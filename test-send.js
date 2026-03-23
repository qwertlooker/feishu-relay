const http = require('http');

console.log('=== 测试获取会话列表 ===\n');

// 1. 先尝试获取会话列表
const options1 = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/chats',
  method: 'GET'
};

const req1 = http.request(options1, (res) => {
  console.log(`获取会话列表 - Status Code: ${res.statusCode}`);
  
  let data = '';
  res.on('data', (d) => {
    data += d.toString();
  });
  
  res.on('end', () => {
    console.log('响应:', data);
    console.log('\n=== 会话列表获取完成 ===\n');
    
    // 如果没有获取到会话，我们需要知道 chatId 才能发送消息
    console.log('提示：要发送消息，需要提供飞书 Chat ID');
    console.log('Chat ID 格式：');
    console.log('  - 私聊：ou_xxxxxxxxxx');
    console.log('  - 群聊：oc_xxxxxxxxxx');
  });
});

req1.on('error', (error) => {
  console.error('错误:', error);
});

req1.end();
