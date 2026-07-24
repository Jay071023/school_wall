# Deploy script - run when SSH is back up
# Usage: powershell -ExecutionPolicy Bypass .\deploy.ps1

$SERVER="root@152.32.226.134"
$KEY="C:\Users\JAYji\.ssh\wall_jay23"
$REMOTE="/www/wwwroot/wall.jay23.cn/frontend/"

$FILES = @(
    "css/style.css",
    "css/mobile-fix.css",
    "js/detail.js",
    "js/user-card.js",
    "post-detail.html"
)

echo "=== Uploading modified files ==="
foreach ($f in $FILES) {
    $local = "D:\编程相关\校墙\frontend\$f"
    $remote = "${REMOTE}${f}"
    echo "  -> $f"
    scp -i $KEY -o StrictHostKeyChecking=no $local "${SERVER}:${remote}" 2>&1
    if ($?) { echo "     OK" } else { echo "     FAILED" }
}

echo ""
echo "Done! Run 'systemctl restart wall' on server if needed."
