/**
 * 针对 Surge 策略组出口 IP 纯净度检测与动态覆盖脚本
 * 环境：Surge iOS 4.9.3+ / Surge Mac 4.0.0+
 */

// --- 参数解析与配置校验 ---
const ARGS = parseArgs($argument);
const TARGET_GROUP = ARGS['group'];
const RAPIDAPI_KEY = ARGS['apikey'];

if (!TARGET_GROUP ||!RAPIDAPI_KEY) {
    terminateUI("配置错误", "请在模块配置中正确填写 TARGET_GROUP 与 PING0_API_KEY。", "error");
}

// --- 底层网络功能 Promise 封装 ---

// 封装 Surge 内部 HTTP API (用于管理策略组状态)
function invokeSurgeAPI(method, path, body = null) {
    return new Promise((resolve, reject) => {
        $httpAPI(method, path, body, (response) => {
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
    return new Promise((resolve) => {
        const startTime = Date.now();
        $httpClient.get({
            url: url,
            headers: extraHeaders,
            policy: policyName,
            timeout: 8 // 单个节点的请求超时设为 8 秒，避免长时间卡死
        }, (error, response, data) => {
            const rtt = Date.now() - startTime;
            if (error || response.status!== 200) {
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
        if (!groupData ||!groupData) {
            throw new Error(`未找到指定的策略组：${TARGET_GROUP}`);
        }

        // 第二步：清洗并提取待测试的节点名称数组
        // 过滤掉内置直连策略，防止将本机 IP 传给 API 检测
        const rawNodes = groupData;
        const validNodes = rawNodes.map(item => typeof item === 'object'? item.name : item)
                                  .filter(name =>!.includes(name));

        if (validNodes.length === 0) {
            throw new Error(`策略组 ${TARGET_GROUP} 中无可用外部代理节点。`);
        }

        // 第三步：高并发探测所有节点的真实物理出口 IP
        // 采用 ipify 接口获取最纯粹的公网 IPv4/IPv6 字符串
        const ipProbePromises = validNodes.map(node => probeViaPolicy("https://api.ipify.org", node));
        const ipResults = await Promise.all(ipProbePromises);
        
        let activeNodes =;
        for (let res of ipResults) {
            if (res.success && res.data) {
                const cleanIP = res.data.trim();
                // 简单的正则过滤，防止返回的是非 IP 内容（如认证页面的 HTML）
                if (/^[\d\.]+$/.test(cleanIP) |

| /^[\da-fA-F:]+$/.test(cleanIP)) {
                    activeNodes.push({ name: res.policy, ip: cleanIP, latency: res.latency });
                }
            }
        }

        if (activeNodes.length === 0) {
            throw new Error("所有节点均无法连接到外网，无法获取出口 IP。");
        }

        // 第四步：基于获取到的出口 IP，并发请求 ping0.cc 的风险评分接口
        // 该接口要求注入特定的鉴权 Header
        const ping0Headers = {
            "X-RapidAPI-Key": RAPIDAPI_KEY,
            "X-RapidAPI-Host": "ping0.xyz",
            "Accept": "application/json"
        };
        
        const riskPromises = activeNodes.map(node => 
            probeViaPolicy(`https://ping0.xyz/rapidapi/lookup/?ip=${node.ip}`, "DIRECT", ping0Headers)
        );
        
        const riskResults = await Promise.all(riskPromises);
        let evaluatedNodes =;

        for (let i = 0; i < activeNodes.length; i++) {
            const riskRes = riskResults[i];
            const node = activeNodes[i];
            
            if (riskRes.success) {
                try {
                    const parsedData = JSON.parse(riskRes.data);
                    // 核心评分逻辑
                    node.risk_score = parseInt(parsedData.risk_score, 10);
                    node.country = parsedData.country_code |

| "未知";
                    node.isp = parsedData.isp |

| "未知 ISP";
                    // 标记是否为 VPN/Proxy 强相关
                    node.is_vpn = parsedData.vpn |

| parsedData.proxy |
| parsedData.tor;
                    
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
        // 核心目标：风险分越低越好；若风险分相同，则应用层 HTTP 握手延迟越低越好。
        // 同时对于带有原生 vpn/proxy 标签的节点进行微观惩罚。
        evaluatedNodes.sort((a, b) => {
            if (a.risk_score!== b.risk_score) {
                return a.risk_score - b.risk_score;
            }
            // 风险分完全一致时的决断：带有代理高危标签的排到后面
            if (a.is_vpn!== b.is_vpn) {
                return a.is_vpn? 1 : -1;
            }
            // 纯净度维度完全相同时，引入延迟作为 Tie-breaker
            return a.latency - b.latency;
        });

        const optimalNode = evaluatedNodes;

        // 第六步：利用内部 HTTP API 突变 Surge 状态矩阵，强制切换策略组
        await invokeSurgeAPI("POST", "/v1/policy_groups/select", {
            group_name: TARGET_GROUP,
            policy: optimalNode.name
        });

        // 第七步：聚合渲染 UI 面板数据
        // 根据 ping0 的权威量化分级动态调整面板色彩 (0-20低风险, 21-50中风险, >50高风险)
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
        terminateUI("⚠️ 纯净度引擎故障", e.message |

| "执行过程中发生未知网络或解析异常。", "error");
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
    if (!argString |

| typeof argString!== "string") return result;
    
    const parts = argString.split('&');
    for (const part of parts) {
        const kv = part.split('=');
        if (kv.length >= 2) {
            const key = kv.shift().toLowerCase().trim();
            // 在解析值时考虑有些特殊字符可能包含等号，需组合剩余片段
            result[key] = kv.join('=').trim();
        }
    }
    return result;
}

// === 引导启动 ===
optimizePurity();
