/**
 * Surge 自动收集失败请求脚本 (完全兼容版)
 * 不依赖任何外部工具函数，内置 Base64 编解码
 */

const config = (function() {
    let obj = {};
    if (typeof $argument !== 'undefined' && $argument) {
        // 使用正则匹配 key=value，兼容 value 中包含等号的情况
        let pairs = $argument.split(/,(?=[a-zA-Z_0-9]+=)/);
        pairs.forEach(pair => {
            let idx = pair.indexOf('=');
            if (idx !== -1) {
                let k = pair.substring(0, idx).trim();
                let v = pair.substring(idx + 1).trim();
                obj[k] = v;
            }
        });
    }
    return obj;
})();

const api_key = config.api_key || "solo";
const github_token = config.github_token;
const repo = config.repo;
const file_path = config.file_path;

// 调试输出：请在控制台确认打印出的长度是否正确（不要打印明文，安全第一）
console.log(`[参数检查] Token 长度: ${github_token ? github_token.length : 0}`);
console.log(`[参数检查] Repo: ${repo}`);
const API_URL = `http://127.0.0.1:6171/v1/requests/recent?x-key=${api_key}`;
const GITHUB_API = `https://api.github.com/repos/${repo}/contents/${file_path}`;
const AUTH_HEADER = `Bearer ${github_token}`;

// --- 内置 Base64 工具 ---
const Base64 = {
    _keyStr: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
    encode: function(e) {
        let t = "", n, r, i, s, o, u, a, f = 0;
        e = this._utf8_encode(e);
        while (f < e.length) {
            n = e.charCodeAt(f++); r = e.charCodeAt(f++); i = e.charCodeAt(f++);
            s = n >> 2; o = (n & 3) << 4 | r >> 4; u = (r & 15) << 2 | i >> 6; a = i & 63;
            if (isNaN(r)) u = a = 64; else if (isNaN(i)) a = 64;
            t = t + this._keyStr.charAt(s) + this._keyStr.charAt(o) + this._keyStr.charAt(u) + this._keyStr.charAt(a)
        }
        return t
    },
    decode: function(e) {
        let t = "", n, r, i, s, o, u, a, f = 0;
        e = e.replace(/[^A-Za-z0-9+/=]/g, "");
        while (f < e.length) {
            s = this._keyStr.indexOf(e.charAt(f++)); o = this._keyStr.indexOf(e.charAt(f++));
            u = this._keyStr.indexOf(e.charAt(f++)); a = this._keyStr.indexOf(e.charAt(f++));
            n = s << 2 | o >> 4; r = (o & 15) << 4 | u >> 2; i = (u & 3) << 6 | a;
            t = t + String.fromCharCode(n);
            if (u != 64) t = t + String.fromCharCode(r);
            if (a != 64) t = t + String.fromCharCode(i)
        }
        return this._utf8_decode(t)
    },
    _utf8_encode: function(e) {
        e = e.replace(/\r\n/g, "\n"); let t = "";
        for (let n = 0; n < e.length; n++) {
            let r = e.charCodeAt(n);
            if (r < 128) t += String.fromCharCode(r);
            else if (r > 127 && r < 2048) { t += String.fromCharCode(r >> 6 | 192); t += String.fromCharCode(r & 63 | 128) }
            else { t += String.fromCharCode(r >> 12 | 224); t += String.fromCharCode(r >> 6 & 63 | 128); t += String.fromCharCode(r & 63 | 128) }
        }
        return t
    },
    _utf8_decode: function(e) {
        let t = "", n = 0, r = c1 = c2 = 0;
        while (n < e.length) {
            r = e.charCodeAt(n);
            if (r < 128) { t += String.fromCharCode(r); n++ }
            else if (r > 191 && r < 224) { c2 = e.charCodeAt(n + 1); t += String.fromCharCode((r & 31) << 6 | c2 & 63); n += 2 }
            else { c2 = e.charCodeAt(n + 1); c3 = e.charCodeAt(n + 2); t += String.fromCharCode((r & 15) << 12 | (c2 & 63) << 6 | c3 & 63); n += 3 }
        }
        return t
    }
};

async function main() {
    try {
        const recentRequests = await fetchRecentFailed();
        if (recentRequests.length === 0) {
            console.log("未发现符合条件的失败请求:");
            console.log(AUTH_HEADER)
            $done(); return;
        }

        const fileInfo = await getGitHubFile();
        const { sha, originalList } = fileInfo;
        
        const newDomains = recentRequests.filter(d => !originalList.includes(d));
        if (newDomains.length === 0) {
            console.log("域名已存在，跳过更新");
            $done(); return;
        }

        const updatedList = [...new Set([...originalList, ...newDomains])].sort();
        const updatedContent = updatedList.join('\n');
        await updateGitHubFile(updatedContent, sha, newDomains);

    } catch (e) {
        console.log("脚本执行出错: " + e);
        $done();
    }
}

function fetchRecentFailed() {
    return new Promise((resolve) => {
        $httpClient.get(API_URL, (err, resp, data) => {
            if (err || !data) return resolve([]);
            try {
                const json = JSON.parse(data);
                const failed = json.requests
                    .filter(r => r.failed === true && r.rule && r.rule.includes("FINAL"))
                    .map(r => r.remoteHost ? r.remoteHost.split(':')[0] : "")
                    .filter(h => h && h.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(h));
                resolve([...new Set(failed)]);
            } catch (e) { resolve([]); }
        });
    });
}

function getGitHubFile() {
    return new Promise((resolve) => {
        $httpClient.get({
            url: GITHUB_API,
            headers: { 
                "Authorization": AUTH_HEADER,
                "User-Agent": "Surge-Script",
                "Accept": "application/vnd.github.v3+json"
            }
        }, (err, resp, data) => {
            if (err || resp.status !== 200) {
                console.log(`GitHub 获取失败: ${resp ? resp.status : err}`);
                return resolve({ sha: null, originalList: [] });
            }
            try {
                const json = JSON.parse(data);
                if (json.content) {
                    const cleanedContent = json.content.replace(/\s/g, '');
                    const decoded = Base64.decode(cleanedContent);
                    const list = decoded.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
                    resolve({ sha: json.sha, originalList: list });
                } else {
                    resolve({ sha: null, originalList: [] });
                }
            } catch (e) {
                console.log("解析 GitHub JSON 失败");
                resolve({ sha: null, originalList: [] });
            }
        });
    });
}

function updateGitHubFile(content, sha, news) {
    return new Promise((resolve) => {
        const body = {
            message: `🤖 Auto-add: ${news.join(', ')}`,
            content: Base64.encode(content),
            sha: sha
        };

        $httpClient.put({
            url: GITHUB_API,
            headers: { 
                "Authorization": AUTH_HEADER,
                "User-Agent": "Surge-Script",
                "Accept": "application/vnd.github.v3+json"
            },
            body: JSON.stringify(body)
        }, (err, resp, data) => {
            if (!err && (resp.status === 200 || resp.status === 201)) {
                $notification.post("Surge 自动分流更新", `成功添加 ${news.length} 个域名`, news.join(', '));
            } else {
                console.log("更新失败: " + data);
            }
            resolve();
            $done();
        });
    });
}

main();
