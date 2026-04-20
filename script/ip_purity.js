/**
 * 针对 Surge 策略组出口 IP 纯净度检测与动态覆盖脚本
 * 环境：Surge iOS 4.9.3+ / Surge Mac 4.0.0+
 */
const defaultArgs = {
    group: "Proxy", // 默认策略组
    apikey: ""      // 默认 API Key
};

// 2. 核心解析与合并逻辑 (模仿你发我的 initArgument 逻辑)
function parseArguments(defaults) {
    // 先克隆一份默认配置
    console.log("$argument: " + $argument)
    let args = Object.assign({}, defaults); 
    
    // 如果存在 Surge 传入的字符串形式的 $argument
    if (typeof $argument === 'string' && $argument.trim() !== '') {
        try {
            
            // 将模块传入的 JSON 字符串反序列化，并覆盖到 args 对象上
            Object.assign(args, JSON.parse($argument));
        } catch (e) {
            console.log("❌ $argument JSON 解析失败，将使用默认配置。错误：" + e.message);
        }
    } 
    // 顺手做个 Loon 兼容 (Loon 的 $argument 已经是 Object 了)
    else if (typeof $argument === 'object' && $argument !== null) {
        Object.assign(args, $argument);
    }
    
    return args;
}

// 3. 获取最终生效的参数
const ARGS = parseArguments(defaultArgs);
const TARGET_GROUP = ARGS.group;
const RAPIDAPI_KEY = ARGS.apikey;
console.log(`当前使用的策略组: ${TARGET_GROUP}`);

if (!TARGET_GROUP || !RAPIDAPI_KEY) {
    terminateUI("配置错误", "请在模块配置中正确填写 TARGET_GROUP 与 PING0_API_KEY。", "error");
}

// --- 底层网络功能 Promise 封装 ---

// 封装 Surge 内部 HTTP API (用于管理策略组状态)
function invokeSurgeAPI(method, path, body = null) {
    return new Promise((resolve, reject) => {
        $httpAPI(method, path, body, (response) => {
            if (!response) return reject(new Error('Surge API 无响应'));
            if (response && response.error) {
                reject(response.error);
            } else {
                resolve(response);
            }
        });
    });
}

// 封装带有底层 policy 强制路由的外部 HTTP 客户端
function probeViaPolicy(url, policyName, extraHeaders = {}) {
    console.log(`测试节点：${policyName}`);
    return new Promise((resolve) => {
        const startTime = Date.now();
        $httpClient.get({
            url: url,
            headers: extraHeaders,
            timeout: 8 // 单个节点的请求超时设为 8 秒，避免长时间卡死
        }, (error, response, data) => {
            const rtt = Date.now() - startTime;
            console.log("res:" + response)
            if (error || !(response && response.status === 200)) {
                resolve({ success: false, policy: policyName, error: error });
            } else {
                resolve({ success: true, policy: policyName, data: data, latency: rtt });
            }
        });
    });
}

// --- 核心执行引擎 ---
async function optimizePurity() {
    try {
        // 第一步：向 Surge 内部拉取策略组配置树
        const groupData = await invokeSurgeAPI("GET", "/v1/policy_groups");
        if (!groupData) {
            throw new Error(`未找到指定的策略组：${TARGET_GROUP}`);
        }

        // 第二步：清洗并提取待测试的节点名称数组
        // 兼容不同返回结构：数组 / 对象映射 / 内嵌 policies
        let rawNodes = [];
        if (Array.isArray(groupData)) {
            const g = groupData.find(item => item && (item.name === TARGET_GROUP || item.group_name === TARGET_GROUP));
            if (g) rawNodes = g.policies || g.nodes || g.list || [];
            else rawNodes = groupData;
        } else if (typeof groupData === 'object') {
            rawNodes = groupData[TARGET_GROUP] || groupData.policies || [];
        }

        const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'GLOBAL', 'DEFAULT'];

        const validNodes = (Array.isArray(rawNodes) ? rawNodes : [])
            .map(item => (typeof item === 'object' ? item.name : item))
            .map(name => String(name || '').trim())
            .filter(name => name && !BUILTIN_POLICIES.includes(name.toUpperCase()));

        if (validNodes.length === 0) {
            throw new Error(`策略组 ${TARGET_GROUP} 中无可用外部代理节点。`);
        }

        // 第四步：基于获取到的出口 IP，并发请求 ping0.cc 的风险评分接口
        const ping0Headers = {
            "x-rapidapi-key": RAPIDAPI_KEY,
            "x-rapidapi-host": "ping0-api.p.rapidapi.com",
            "Content-Type": "application/json"
        };

        const riskPromises = validNodes.map(node =>
            probeViaPolicy(`https://ping0-api.p.rapidapi.com/rapidapi/lookup?ip=${encodeURIComponent(node.ip)}`, node, ping0Headers)
        );

        const riskResults = await Promise.all(riskPromises);
        let evaluatedNodes = [];

        for (let i = 0; i < validNodes.length; i++) {
            const riskRes = riskResults[i];
            const node = validNodes[i];

            if (riskRes && riskRes.success) {
                try {
                    const parsedData = typeof riskRes.data === 'string' ? JSON.parse(riskRes.data) : riskRes.data;
                    node.risk_score = parseInt(parsedData.risk_score || parsedData.score || 0, 10) || 0;
                    node.country = parsedData.country_code || parsedData.country || "未知";
                    node.isp = parsedData.isp || "未知 ISP";
                    node.is_vpn = Boolean(parsedData.vpn || parsedData.proxy || parsedData.tor);

                    evaluatedNodes.push(node);
                } catch (e) {
                    console.log(`JSON 解析失败对于节点 ${node.name}：${e.message}`);
                }
            }
        }

        if (evaluatedNodes.length === 0) {
            throw new Error("全部节点的纯净度数据获取均失败，请检查 API Key 额度或网络状态。");
        }

        // 第五步：决策排序引擎
        evaluatedNodes.sort((a, b) => {
            if (a.risk_score !== b.risk_score) return a.risk_score - b.risk_score;
            if (a.is_vpn !== b.is_vpn) return a.is_vpn ? 1 : -1;
            return (a.latency || 0) - (b.latency || 0);
        });

        const optimalNode = evaluatedNodes[0];

        if (!optimalNode) throw new Error('无法选出最佳节点。');

        // 第六步：利用内部 HTTP API 切换策略组
        await invokeSurgeAPI("POST", "/v1/policy_groups/select", {
            group_name: TARGET_GROUP,
            policy: optimalNode.name
        });

        // 第七步：聚合渲染 UI 面板数据
        let uiStyle = "info";
        let uiIcon = "shield.lefthalf.filled";
        let uiIconColor = "#007AFF";

        if (optimalNode.risk_score <= 20) {
            uiStyle = "good";
            uiIcon = "checkmark.shield.fill";
            uiIconColor = "#34C759"; // iOS Green
        } else if (optimalNode.risk_score > 50) {
            uiStyle = "error";
            uiIcon = "exclamationmark.shield.fill";
            uiIconColor = "#FF3B30"; // iOS Red
        }

        const uiContent = `最佳节点: ${optimalNode.name}\n` +
            `出口 IP: ${optimalNode.ip} (${optimalNode.country})\n` +
            `风险指数: ${optimalNode.risk_score}/100 (延迟: ${optimalNode.latency}ms)\n` +
            `本次共评估了 ${evaluatedNodes.length} 个活跃节点的纯净度。`;

        $done({
            title: "✅ 智能纯净度路由优化完毕",
            content: uiContent,
            style: uiStyle,
            icon: uiIcon,
            "icon-color": uiIconColor
        });

    } catch (e) {
        const msg = (e && e.message) ? e.message : String(e || "执行过程中发生未知网络或解析异常。");
        terminateUI("⚠️ 纯净度引擎故障", msg || "执行过程中发生未知网络或解析异常。", "error");
    }
}

// 辅助方法：异常拦截与 UI 退退
function terminateUI(title, content, style) {
    $done({
        title: title,
        content: content,
        style: style,
        icon: "xmark.octagon.fill",
        "icon-color": "#FF3B30"
    });
}

// 辅助方法：安全解析 $argument 键值对字符串
function parseArgs(argString) {
    let result = {};
    if (!argString || typeof argString !== "string") return result;

    const parts = argString.split('&');
    for (const part of parts) {
        const kv = part.split('=');
        if (kv.length >= 2) {
            const key = kv.shift().toLowerCase().trim();
            result[key] = kv.join('=').trim();
        }
    }
    return result;
}

// === 引导启动 ===
optimizePurity();
