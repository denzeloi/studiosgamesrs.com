// ==========================================================
// DASHBOARD-EXTRAS.JS - Perfil Fénix (Complemento)
// ==========================================================

// Este archivo complementa dashboard-logic.js sin reemplazarlo
// Se carga DESPUÉS de dashboard-logic.js

(function() {
    console.log('🔥 Extras del Perfil Fénix iniciando...');
    
    // ==========================================================
    // VARIABLES DEL PERFIL FÉNIX
    // ==========================================================
    const Fenix = {
        // Elementos específicos del Perfil Fénix
        elements: {
            powerRingProgress: document.getElementById('powerRingProgress'),
            powerRingLevel: document.getElementById('powerRingLevel'),
            influenceLevel: document.getElementById('influenceLevel'),
            influenceReferrals: document.getElementById('influenceReferrals'),
            influenceBadges: document.getElementById('influenceBadges'),
            badgesForgeContainer: document.getElementById('badgesForgeContainer'),
            badgesCount: document.getElementById('nexus-badges-count'),
            steamFlame: document.getElementById('steamFlameIndicator'),
            steamTitle: document.getElementById('steamStatusTitle'),
            steamSubtitle: document.getElementById('steamStatusSubtitle'),
            steamBtn: document.getElementById('steamActionBtn'),
            steamFill: document.getElementById('steamFlameFill'),
            dragonAuraCanvas: document.getElementById('dragonAuraCanvas'),
            cosmicParticles: document.getElementById('cosmicParticles'),
            avatarEnergyParticles: document.getElementById('avatarEnergyParticles')
        },
        
        // Datos de Steam
        steamData: null,
        
        // ======================================================
        // INICIALIZACIÓN
        // ======================================================
        init: function() {
            console.log('✨ Inicializando componentes del Perfil Fénix...');
            this.createCosmicParticles();
            this.initDragonAura();
            this.checkSteamData();
            this.createEnergyParticles();
            this.enhanceExistingFunctions();
        },
        
        // ======================================================
        // VERIFICAR STEAM (usa datos existentes de dashboard-logic)
        // ======================================================
        checkSteamData: function() {
            try {
                const storedSteam = localStorage.getItem('usuario_steam');
                
                if (storedSteam) {
                    this.steamData = JSON.parse(storedSteam);
                    console.log('🎮 Steam detectado:', this.steamData.personaname);
                    this.updateSteamFlame(true);
                } else {
                    this.updateSteamFlame(false);
                }
            } catch (e) {
                console.error('Error al leer Steam:', e);
                this.updateSteamFlame(false);
            }
        },
        
        // ======================================================
        // ACTUALIZAR LLAMA DE STEAM
        // ======================================================
        updateSteamFlame: function(isConnected) {
            const e = this.elements;
            if (!e.steamFlame) return;
            
            if (isConnected) {
                e.steamFlame.classList.add('connected');
                if (e.steamTitle) e.steamTitle.textContent = 'LLAMA DE STEAM';
                if (e.steamSubtitle) e.steamSubtitle.textContent = 'Cuenta Vinculada';
                if (e.steamBtn) {
                    e.steamBtn.innerHTML = '<i class="fas fa-check"></i> VINCULADO';
                    e.steamBtn.classList.add('connected');
                    e.steamBtn.href = '#';
                }
                if (e.steamFill) e.steamFill.style.width = '100%';
            } else {
                e.steamFlame.classList.remove('connected');
                if (e.steamTitle) e.steamTitle.textContent = 'LLAMA DE STEAM';
                if (e.steamSubtitle) e.steamSubtitle.textContent = 'Cuenta no vinculada';
                if (e.steamBtn) {
                    e.steamBtn.innerHTML = '<i class="fas fa-link"></i> VINCULAR';
                    e.steamBtn.classList.remove('connected');
                    e.steamBtn.href = 'profile-settings.html';
                }
                if (e.steamFill) e.steamFill.style.width = '30%';
            }
        },
        
        // ======================================================
        // ACTUALIZAR ANILLO DE PODER
        // ======================================================
        updatePowerRing: function(level, maxLevel = 100) {
            if (!this.elements.powerRingProgress || !this.elements.powerRingLevel) return;
            
            const circumference = 2 * Math.PI * 54;
            const progress = level / maxLevel;
            const offset = circumference * (1 - Math.min(progress, 1));
            
            this.elements.powerRingProgress.style.strokeDashoffset = offset;
            this.elements.powerRingLevel.textContent = level;
        },
        
        // ======================================================
        // CREAR PARTÍCULAS CÓSMICAS
        // ======================================================
        createCosmicParticles: function() {
            const container = this.elements.cosmicParticles;
            if (!container) return;
            
            // Limpiar partículas existentes
            container.innerHTML = '';
            
            for (let i = 0; i < 50; i++) {
                const particle = document.createElement('div');
                particle.className = 'cosmic-particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.animationDelay = Math.random() * 10 + 's';
                particle.style.width = Math.random() * 3 + 1 + 'px';
                particle.style.height = particle.style.width;
                particle.style.opacity = Math.random() * 0.5 + 0.2;
                container.appendChild(particle);
            }
        },
        
        // ======================================================
        // INICIALIZAR AURA DE DRAGÓN
        // ======================================================
        initDragonAura: function() {
            const canvas = this.elements.dragonAuraCanvas;
            if (!canvas) return;
            
            const ctx = canvas.getContext('2d');
            let time = 0;
            
            const drawAura = () => {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                
                // Obtener color según rango (intenta leer de dashboard-logic)
                const rankElement = document.getElementById('nexus-profile-rank') || 
                                   document.getElementById('competitiveRoleEnhanced');
                const rank = rankElement ? rankElement.textContent : 'WARRIOR';
                const hue = rank.includes('COMMANDER') ? 0 : 
                           rank.includes('DIVISIONAL') ? 45 : 200;
                
                for (let i = 0; i < 8; i++) {
                    const angle = (i / 8) * Math.PI * 2 + time;
                    const radius = 150 + Math.sin(time * 2 + i) * 20;
                    const x = canvas.width / 2 + Math.cos(angle) * radius;
                    const y = canvas.height / 2 + Math.sin(angle) * radius;
                    
                    const gradient = ctx.createRadialGradient(x, y, 0, x, y, 40);
                    gradient.addColorStop(0, `hsla(${hue}, 100%, 60%, 0.3)`);
                    gradient.addColorStop(1, 'transparent');
                    
                    ctx.beginPath();
                    ctx.arc(x, y, 40, 0, Math.PI * 2);
                    ctx.fillStyle = gradient;
                    ctx.fill();
                }
                
                time += 0.02;
                requestAnimationFrame(drawAura);
            };
            
            drawAura();
        },
        
        // ======================================================
        // CREAR PARTÍCULAS DE ENERGÍA
        // ======================================================
        createEnergyParticles: function() {
            const container = this.elements.avatarEnergyParticles;
            if (!container) return;
            
            // Limpiar partículas existentes
            container.innerHTML = '';
            
            for (let i = 0; i < 12; i++) {
                const particle = document.createElement('div');
                particle.className = 'energy-particle';
                
                const angle = (i / 12) * Math.PI * 2;
                const distance = 80 + Math.random() * 20;
                
                particle.style.setProperty('--x', Math.cos(angle) * distance + 'px');
                particle.style.setProperty('--y', Math.sin(angle) * distance + 'px');
                particle.style.left = '50%';
                particle.style.top = '50%';
                particle.style.animationDelay = Math.random() * 2 + 's';
                particle.style.animationDuration = (Math.random() * 3 + 2) + 's';
                
                container.appendChild(particle);
            }
        },
        
        // ======================================================
        // MEJORAR FUNCIONES EXISTENTES (sin reemplazarlas)
        // ======================================================
        enhanceExistingFunctions: function() {
            // Guardar referencia a funciones originales
            const originalShowFloatingMessage = window.showFloatingMessage;
            
            // Mejorar showFloatingMessage para que sea más épico
            window.showFloatingMessage = function(message, type = 'success') {
                // Llamar a la función original si existe
                if (originalShowFloatingMessage) {
                    originalShowFloatingMessage(message, type);
                }
                
                // Añadir efectos extra
                const flameBar = Fenix.elements.steamFill;
                if (flameBar && type === 'success') {
                    flameBar.style.transition = 'width 0.5s ease';
                    flameBar.style.width = '100%';
                    setTimeout(() => {
                        flameBar.style.width = Fenix.steamData ? '100%' : '30%';
                    }, 2000);
                }
            };
            
            // Observar cambios en datos de usuario (si existen)
            this.observeUserData();
        },
        
        // ======================================================
        // OBSERVAR CAMBIOS EN DATOS DE USUARIO
        // ======================================================
        observeUserData: function() {
            // Intentar leer nivel de elementos existentes
            const checkInterval = setInterval(() => {
                const levelElement = document.getElementById('profileNickname');
                if (levelElement && levelElement.textContent !== 'Loading...') {
                    // Simular nivel (esto debería venir de tu backend)
                    const randomLevel = Math.floor(Math.random() * 50) + 1;
                    this.updatePowerRing(randomLevel);
                    
                    if (this.elements.influenceLevel) {
                        this.elements.influenceLevel.textContent = randomLevel;
                    }
                    
                    clearInterval(checkInterval);
                }
            }, 1000);
            
            // Detener después de 10 segundos
            setTimeout(() => clearInterval(checkInterval), 10000);
        }
    };
    
    // ==========================================================
    // FUNCIONES GLOBALES PARA BOTONES (si no existen)
    // ==========================================================
    
    // Solo definir si no existen
    if (typeof window.copyReferralCode !== 'function') {
        window.copyReferralCode = function() {
            const userId = localStorage.getItem('userId') || 'STUDIOS42';
            navigator.clipboard.writeText(userId).then(() => {
                if (window.showFloatingMessage) {
                    window.showFloatingMessage('✅ Código copiado: ' + userId, 'success');
                } else {
                    alert('Código copiado: ' + userId);
                }
            });
        };
    }
    
    if (typeof window.showRewards !== 'function') {
        window.showRewards = function() {
            if (window.showFloatingMessage) {
                window.showFloatingMessage('🎁 Próximamente: Sistema de recompensas', 'info');
            } else {
                alert('Próximamente: Sistema de recompensas');
            }
        };
    }
    
    if (typeof window.toggleBadges !== 'function') {
        window.toggleBadges = function() {
            const badgesGrid = document.getElementById('nexus-badges-container');
            const arrow = document.getElementById('nexus-badges-arrow');
            
            if (badgesGrid && arrow) {
                badgesGrid.classList.toggle('expanded');
                arrow.style.transform = badgesGrid.classList.contains('expanded') ? 'rotate(180deg)' : 'rotate(0deg)';
            }
        };
    }
    
    // ==========================================================
    // INICIALIZAR CUANDO EL DOM ESTÉ LISTO
    // ==========================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => Fenix.init());
    } else {
        Fenix.init();
    }
    
    // También inicializar cuando dashboard-logic termine (evento personalizado)
    document.addEventListener('dashboard-ready', () => {
        console.log('📡 Dashboard listo, actualizando Perfil Fénix...');
        Fenix.checkSteamData();
        Fenix.observeUserData();
    });
    
    // Disparar evento cuando este script cargue
    setTimeout(() => {
        document.dispatchEvent(new Event('fenix-ready'));
    }, 100);
    
})();