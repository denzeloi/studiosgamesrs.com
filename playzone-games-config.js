/**
 * CONFIG CENTRAL DE JUEGOS - StudiosGamesRS
 * Lista unificada para: Creador de misiones, Filtros, Onboarding, Búsqueda
 */
window.PlayzoneGames = window.PlayzoneGames || {
  all: [
    { id: 'Counter-Strike 2', img: 'cs2.jpg' },
    { id: 'Valorant', img: 'Valorant.jpg' },
    { id: 'League of Legends', img: 'LoL.jpg' },
    { id: 'Apex Legends', img: 'apex-legends.jpg' },
    { id: 'Fortnite', img: 'fortnite.jpg' },
    { id: 'Rocket League', img: 'Rocket-league.jpg' },
    { id: 'GTA V', img: 'gta-5.jpg' },
    { id: 'ARK: Survival Evolved', img: 'default-game.jpg' },
    { id: 'Call of Duty', img: 'callofduty.jpg' },
    { id: 'Battlefield', img: 'Battlefield 6.jpg' },
    { id: 'Minecraft', img: 'minecraft.jpg' },
    { id: 'Overwatch 2', img: 'overwatch.jpg' },
    { id: 'PUBG', img: 'pugb.jpg' },
    { id: 'Rainbow Six Siege', img: 'rainbow.jpg'},
    { id: 'Otro', img: 'default-game.jpg' }
  ],
  getImage: function(gameId) {
    var g = this.all.find(function(x) { return x.id === gameId; });
    return '/img_playzone/' + (g ? g.img : 'default-game.jpg');
  }
};
