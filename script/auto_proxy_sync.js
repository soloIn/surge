/**
 * Surge 自动收集失败请求脚本 (优化版)
 */

const { api_key, github_token, repo, file_path } = (function() {
    const args = $argument.split(',').reduce((acc, cur) => {
        const pair = cur.split('=');
        if (pair.length === 2) acc[pair[0].trim()] = pair[1].trim();
        return acc;
    }, {});
    return args;
})();

const API_URL = `http://127.0.0.1:6171/v1/requests/recent?x-key=${api_key}`;
const GITHUB_API = `https://api.github.com/repos/${repo}/contents/${file_path}`;

async function main() {
    try {
        const recentRequests = await fetchRecentFailed();
        if (recentRequests.length === 0) {
            console.log("没有符合条件的失败请求");
            $done(); return;
        }

        const fileInfo = await getGitHubFile();
        const { sha, originalList } = fileInfo;
        
        const newDomains = recentRequests.filter(d => !originalList.includes(d));
        
        if (newDomains.length === 0) {
            console.log("域名已存在，无需更新");
            $done(); return;
        }

        const updatedList = [...originalList, ...newDomains].sort();
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
                    .filter(h => h && h.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(h)); // 排除纯IP
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
                "Authorization": `token ${github_token}`,
                "User-Agent": "Surge-Script",
                "Accept": "application/vnd.github.v3+json"
            }
        }, (err, resp, data) => {
            if (err || resp.status !== 200) {
                console.log("无法获取 GitHub 文件，可能文件不存在，将尝试新建");
                return resolve({ sha: null, originalList: [] });
            }
            const json = JSON.parse(data);
            if (json.content) {
                // 使用 Surge 内置的 $util.base64Decode 确保兼容性
                const decoded = $utils.base64Decode(json.content.replace(/\s/g, ''));
                // 解决 UTF-8 编码问题
                const content = $utils.decodeURIComponent(escape(decoded));
                const list = content.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
                resolve({ sha: json.sha, originalList: list });
            } else {
                resolve({ sha: null, originalList: [] });
            }
        });
    });
}

function updateGitHubFile(content, sha, news) {
    return new Promise((resolve) => {
        let body = {
            message: `🤖 Auto-add: ${news.join(', ')}`,
            // 使用 Surge 内 testamentary 的 $util.base64Encode
            content: $utils.base64Encode(content)
        };
        if (sha) body.sha = sha;

        $httpClient.put({
            url: GITHUB_API,
            headers: { 
                "Authorization": `token ${github_token}`,
                "User-Agent": "Surge-Script",
                "Accept": "application/vnd.github.v3+json"
            },
            body: JSON.stringify(body)
        }, (err, resp, data) => {
            if (!err && (resp.status === 200 || resp.status === 201)) {
                $notification.post("Surge 自动分流更新", `成功添加 ${news.length} 个域名`, news.join('\n'));
            } else {
                console.log("上传失败: " + data);
            }
            resolve();
            $done();
        });
    });
}

main();
