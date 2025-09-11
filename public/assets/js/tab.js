// --- Lógica del menú de pestañas ---
function showTab(tabId) {
    // Oculta todo el contenido de las pestañas
    document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
    });

    // Quita la clase 'active' de todas las pestañas
    document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.remove('active');
    });

    // Muestra el contenido de la pestaña seleccionada y activa la pestaña
    document.getElementById(tabId).classList.add('active');
    event.currentTarget.classList.add('active');
}