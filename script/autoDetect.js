/**
 * 自动探测重试脚本 (支持 POST & Body)
 */

const { url, method, headers, body, bodyBytes } = $request;

// 1. 如果响应状态码正常，直接返回
if ($response.status < 500) {
    console.log('探测到正常直连')
    $done({});
} else {
    console.log(`探测到直连失败 (${$response.status}): ${url}，尝试代理重试...`);
    
    // 2. 准备重试请求
    // 注意：如果有 bodyBytes (二进制)，优先使用 bodyBytes
    const options = {
        url: url,
        method: method,
        headers: headers,
        body: bodyBytes ? bodyBytes : body, 
        node: "代理" // 确保这里是你代理策略组的名字
    };

    // 3. 使用相应的 HTTP 方法重试
    $httpClient[method.toLowerCase()](options, (err, resp, data) => {
        if (!err && resp.status < 500) {
            console.log(`代理重试成功: ${url}`);
            $notification.post("自动代理救援", "已通过代理成功重试", url);
            
            // 返回代理获取的结果给客户端
            $done({
                response: {
                    status: resp.status,
                    headers: resp.headers,
                    body: data
                }
            });
        } else {
            console.log(`代理重试也失败: ${err || resp.status}`);
            $done({}); // 彻底失败，返回原样
        }
    });
}