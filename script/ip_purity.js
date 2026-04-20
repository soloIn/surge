// ===== 配置 =====
const GROUP = "Auto-IP";
const API = "https://ipinfo.io/json?token=YOUR_TOKEN";

const IDC = ["amazon","google","microsoft","oracle","ovh","linode","digitalocean"];
const ISP = ["softbank","ntt","kddi","docomo","comcast","verizon"];

const SWITCH_COOLDOWN = 600;

// ===== 主流程 =====
(async () => {
  let proxies = $surge.selectGroupDetails(GROUP).candidates;
  let results = [];

  for (let node of proxies) {
    let info = await testNode(node);
    results.push(info);
  }

  results.sort((a,b) => b.score - a.score);

  let best = results[0];

  let now = Date.now() / 1000;
  let last = $persistentStore.read("last_switch") || 0;

  if (best.score > 70 && (now - last > SWITCH_COOLDOWN)) {
    $surge.setSelectGroupPolicy(GROUP, best.name);
    $persistentStore.write(now.toString(), "last_switch");
  }

  $persistentStore.write(JSON.stringify(results), "ip_scores");

  $done();
})();

// ===== 节点检测 =====
function testNode(name) {
  return new Promise((resolve) => {
    $httpClient.get({
      url: API,
      policy: name,
      timeout: 5000
    }, (err, resp, data) => {

      if (err) {
        resolve({ name, score: 0, level: "🔴" });
        return;
      }

      let json = JSON.parse(data);
      let org = (json.org || "").toLowerCase();
      let country = json.country;

      let score = 100;

      // === ASN判断 ===
      IDC.forEach(k => {
        if (org.includes(k)) score -= 60;
      });

      ISP.forEach(k => {
        if (org.includes(k)) score += 20;
      });

      // === 国家 ===
      if (country !== "JP") score -= 20;

      // === IPPure思路（简化模拟）===
      if (org.includes("hosting") || org.includes("cloud")) {
        score -= 20;
      }

      let level = "🟢";
      if (score < 80) level = "🟡";
      if (score < 50) level = "🔴";

      resolve({
        name,
        ip: json.ip,
        org,
        country,
        score,
        level
      });
    });
  });
}
