  const messages = [
      "Extrayendo alertas",
      "Espere un momento, por favor",
      "Cargando información"
    ];
    let msgIndex = 0;
    let messageInterval;

    function startMessageRotation() {
      const loadingText = document.getElementById("loadingText");
      if (!loadingText) return;
      messageInterval = setInterval(() => {
        msgIndex = (msgIndex + 1) % messages.length;
        loadingText.childNodes[0].nodeValue = messages[msgIndex];
      }, 5000); // Cambia cada 5 segundos
    }

    function stopMessageRotation() {
      clearInterval(messageInterval);
    }

    function showLoading() {
      const overlay = document.getElementById("loadingOverlay");
      if (!overlay) return;
      overlay.style.display = "flex";
      startMessageRotation();
    }

    function hideLoading() {
      const overlay = document.getElementById("loadingOverlay");
      if (!overlay) return;
      overlay.style.display = "none";
      stopMessageRotation();
    }
