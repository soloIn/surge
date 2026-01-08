/**
 * Surge 自动收集失败请求脚本
 */

const { api_key, github_token, repo, file_path } = (function() {
    const args = $argument.split(',').reduce((acc, cur) => {
        const [k, v] = cur.split('=');
        acc[k] = v;
        return acc;
    }, {});
    return args;
})();

const API_URL = `http://127.0.0.1:6171/v1/requests/recent?x-key=${api_key}`;
const GITHUB_API = `https://api.github.com/repos/${repo}/contents/${file_path}`;

async function main() {
    try {
        // 1. 获取最近失败请求
        const recentRequests = await fetchRecentFailed();
        if (recentRequests.length === 0) {
            console.log("没有发现符合条件的失败请求");
            $done();
            return;
        }

        // 2. 获取 GitHub 现有列表
        const { content, sha, originalList } = await getGitHubFile();
        
        // 3. 过滤出真正需要新增的域名
        const newDomains = recentRequests.filter(d => !originalList.includes(d));
        
        if (newDomains.length === 0) {
            console.log("所有失败域名已在列表中");
            $done();
            return;
        }

        // 4. 合并并上传
        const updatedList = [...originalList, ...newDomains].sort();
        const updatedContent = updatedList.join('\n');
        await updateGitHubFile(updatedContent, sha, newDomains);

    } catch (e) {
        console.log("错误: " + e);
        $done();
    }
}

// 获取最近失败请求逻辑
function fetchRecentFailed() {
    return new Promise((resolve) => {
        $httpClient.get(API_URL, (err, resp, data) => {
            if (err) return resolve([]);
            const json = JSON.parse(data);
            const failed = json.requests
                .filter(r => r.failed === true && r.rule && r.rule.includes("FINAL"))
                .map(r => {
                    // 处理 remoteHost (njav.tv:443 -> njav.tv)
                    let host = r.remoteHost ? r.remoteHost.split(':')[0] : "";
                    return host;
                })
                .filter(h => h && h.includes(".")); // 简单过滤有效域名
            resolve([...new Set(failed)]); // 去重
        });
    });
}

// 获取 GitHub 文件
function getGitHubFile() {
    return new Promise((resolve, reject) => {
        $httpClient.get({
            url: GITHUB_API,
            headers: { "Authorization": `token ${github_token}`, "User-Agent": "Surge-Script" }
        }, (err, resp, data) => {
            if (resp.status === 404) return resolve({ content: "", sha: "", originalList: [] });
            const json = JSON.parse(data);
            // 解码 base64 内容并转为数组
            const content = atob(json.content.replace(/\s/g, ''));
            const list = content.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
            resolve({ content, sha: json.sha, originalList: list });
        });
    });
}

// 更新 GitHub 文件
function updateGitHubFile(content, sha, news) {
    return new Promise((resolve) => {
        $httpClient.put({
            url: GITHUB_API,
            headers: { "Authorization": `token ${github_token}`, "User-Agent": "Surge-Script" },
            body: JSON.stringify({
                message: `🤖 Auto-add: ${news.join(', ')}`,
                content: btoa(content),
                sha: sha
            })
        }, (err, resp, data) => {
            if (!err) {
                $notification.post("Surge 自动分流更新", `成功添加 ${news.length} 个域名`, news.join('\n'));
            }
            resolve();
            $done();
        });
    });
}

main();