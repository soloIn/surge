async function operator(proxies, targetPlatform, context) {
    const $ = $substore;
    //scriptResourceCache._cleanup(undefined, 3 * 60 * 1000);
    const { isLoon, isSurge, isNode } = $.env
    // --- 配置区域 ---
    const SCAMALYTICS_USER = "69e823b2dcc01";
    const SCAMALYTICS_KEY = "59f4d0437b6242d8270dff1092979c2b9b25b0a69f210e7de44f7017b499451e";
    const ping0_KEY = "7b1e7f9340msh18b6fd812065fcdp12fc22jsn72fe3d4aa786"
    const MAX_RISK = $arguments.risk || 6;
    const concurrency = $arguments.concurrency || 10
    const timeout = $arguments.timeout || 5000
    const surge_http_api = $arguments.surge_http_api
    const surge_http_api_protocol = $arguments.surge_http_api_protocol || 'http'
    const surge_http_api_key = $arguments.surge_http_api_key
    const surge_http_api_enabled = surge_http_api
    const method = $arguments.method || 'get'
    const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined
    const cacheEnabled = $arguments.cache || true
    const cache = scriptResourceCache
    if (!surge_http_api_enabled && !isLoon && !isSurge)
        throw new Error('请使用 Loon, Surge(ability=http-client-policy) 或 配置 HTTP API')

    let lastPing0Time = 0;
    let ping0Lock = Promise.resolve();
    // --- 核心执行器：真正调用 /v1/scripting/evaluate ---
    async function remoteProxyRequest(nodeDescriptor, url) {
        // --- 关键步骤 1：利用 Sub-Store 工具类生成 Surge 节点描述 ---

        // --- 关键步骤 2：通过指定 node 发起请求获取落地 IP ---
        // 就像脚本 2 做的那样，传入 node 参数，Surge 就会用这个节点去访问
        let ipRes;
        try {
            ipRes = await $.http.get({
                url: 'http://ip-api.com/json',
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
                },
                'policy-descriptor': nodeDescriptor,
                nodeDescriptor,
                timeout
            });
        } catch (err) {
            throw new Error(`IP 查询请求失败: ${err.message}`);
        }
        let ipData;
        try {
            ipData = JSON.parse(ipRes.body);
        } catch (e) {
            throw new Error('IP 查询返回数据解析失败');
        }
        const exitIP = ipData.query;
        //$.info(`远程请求结果 - 出口 IP: ${exitIP}`);
        // 返回的是经过节点代理后的响应体 (ip-api 的结果)
        return ipData;
    }
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    // --- 单个节点检测逻辑 ---
    async function checkNode(proxy) {
        try {
            // 1. 转换节点格式为 Surge 可识别格式
            const cacheKey = proxy.server + ':' + proxy.port;
            const node = ProxyUtils.produce([proxy], surge_http_api_enabled ? 'Surge' : target)
            // 2. 触发远程 Surge 拨号获取落地 IP

            // $.info(`cacheKey: ${cacheKey}`)
            // const cacheResult = cache.get(cacheKey);
            // if (cacheResult !== null) {
            //     $.info(`[${proxy.name}] 使用缓存的 IP 数据: ${cacheResult}`);
            //     if (cacheResult > MAX_RISK) return null;
            //     proxy.name = `${proxy.name} | [${cacheResult}]`;
            //     return proxy;
            // }
            
            let exitIP;
            if (ProxyUtils.isIP(proxy.server)) {
                    $.info(`[${proxy.name}] 直接使用 IP 进行风险查询...`);
                    exitIP = proxy.server;
            } else {
                $.info(`[${proxy.name}] 远程请求落地 IP...`);
                const ipData = await remoteProxyRequest(node, 'http://ip-api.com/json?lang=en');
                 exitIP = ipData.query;

            }
            
            if (!exitIP) throw new Error("未能获取到有效出口 IP");
            $.info(`[${proxy.name}] 落地 IP: ${exitIP}，查询风险分...`);

            // 3. 查询 Scamalytics (直接请求即可，无需走远程代理)
            // await (ping0Lock = ping0Lock.then(async () => {
            //     const now = Date.now();
            //     const waitTime = Math.max(0, delay * 1000 - (now - lastPing0Time));

            //     if (waitTime > 0) {
            //         $.info(`[${proxy.name}] 全局限速，等待 ${waitTime} ms`);
            //         await sleep(waitTime);
            //     }

            //     lastPing0Time = Date.now();
            // }));

            let scamRes;
            try {
                scamRes = await $.http.get({
                    url: `https://api11.scamalytics.com/v3/${SCAMALYTICS_USER}?key=${SCAMALYTICS_KEY}&ip=${exitIP}`,
                    // headers: {
                    //     'X-RapidAPI-Host': 'ping0-api.p.rapidapi.com',
                    //     'X-RapidAPI-Key': ping0_KEY,
                    //     'content-type': 'application/json'
                    // },
                    timeout
                });
            } catch (err) {
                throw new Error(`Scamalytics 请求失败: ${err.message}`);
            }

            if (!scamRes || scamRes.statusCode !== 200) {
                throw new Error(`Scamalytics 状态码异常: ${scamRes.statusCode}`);
            }

            let scamData;
            try {
                scamData = JSON.parse(scamRes.body);
            } catch (e) {
                throw new Error('Scamalytics 返回数据解析失败');
            }

            if (!scamData?.scamalytics) {
                throw new Error('Scamalytics 返回结构异常');
            }

            const score = parseInt(scamData.scamalytics.scamalytics_score);
            if (isNaN(score)) {
                throw new Error('风险分解析失败');
            }
            $.info(`[${proxy.name}] 最终得分: ${score}`);
            // 4. 重命名与过滤
            if (score > MAX_RISK) return null;
            return proxy;

        } catch (e) {
            $.error(`[${proxy.name}] 检测失败: ${e.message}`, e.stack);
            return proxy; // 失败则保留原样
        }
    }

    // --- 并发控制执行 ---
    const results = [];
    let cursor = 0;
    const workers = Array(concurrency).fill(0).map(async () => {
        while (cursor < proxies.length) {
            const i = cursor++;
            $.info(`${proxies[i].name} ${proxies[i].server}:${proxies[i].port} - 开始检测...`);
            results[i] = await checkNode(proxies[i]);
        }
    });

    await Promise.all(workers);
    return results.filter(Boolean);
}
