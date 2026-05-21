let isLogin = true;

// Check if already logged in
fetch('/api/me').then(res => {
    if (res.ok) window.location.href = '/dashboard.html';
});

function toggleAuth(e) {
    e.preventDefault();
    isLogin = !isLogin;
    document.getElementById('auth-title').innerText = isLogin ? 'Sign In' : 'Create Account';
    document.getElementById('auth-subtitle').innerText = isLogin ? 'Access your documents securely.' : 'Start your secure workspace today.';
    document.getElementById('confirm-password-group').style.display = isLogin ? 'none' : 'block';
    document.getElementById('confirmPassword').required = !isLogin;
    document.getElementById('auth-btn').innerText = isLogin ? 'Sign In' : 'Sign Up';
    document.getElementById('toggle-text').innerText = isLogin ? "Don't have an account?" : "Already have an account?";
    document.getElementById('toggle-link').innerText = isLogin ? "Create one" : "Sign In";
    document.getElementById('error-msg').innerText = "";
}

async function submitAuth() {
    const errorMsg = document.getElementById('error-msg');
    errorMsg.innerText = "";

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const honeypot = document.getElementById('honeypot').value;

    const endpoint = isLogin ? '/api/login' : '/api/register';
    const body = { username, password, honeypot };
    if (!isLogin) body.confirmPassword = confirmPassword;

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        
        if (data.success) {
            window.location.href = '/dashboard.html';
        } else {
            errorMsg.innerText = data.error;
        }
    } catch (err) {
        errorMsg.innerText = "Connection error.";
    }
}
