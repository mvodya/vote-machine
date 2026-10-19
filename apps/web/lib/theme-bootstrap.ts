// The tiny head script runs before the browser paints any page
export const themeBootstrap = `(function(){try{var p=localStorage.getItem('vm-theme');document.documentElement.dataset.theme=p==='light'||p==='dark'?p:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}catch(e){}})()`;
