/**
 * Punto de entrada de las Cloud Functions.
 * Aquí solo se "encienden" las funciones. Esta carpeta despliega ÚNICAMENTE
 * la función awardMissionTokens (el reparto automático de tokens de PlayZone).
 *
 * IMPORTANTe: al desplegar usa SIEMPRE el comando con el nombre específico:
 *     firebase deploy --only functions:awardMissionTokens
 * Así NO se tocan ni se borran tus otras funciones ya existentes.
 */
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp();
}

const missionTokens = require('./awardMissionTokens');
exports.escrowMissionPrize = missionTokens.escrowMissionPrize;
exports.awardMissionTokens = missionTokens.awardMissionTokens;
exports.refundMissionEscrow = missionTokens.refundMissionEscrow;
exports.getPlayzoneRewardBudget = missionTokens.getPlayzoneRewardBudget;
exports.refillPlayzoneRewardBudget = missionTokens.refillPlayzoneRewardBudget;
exports.joinMission = missionTokens.joinMission;
exports.sendMissionInvite = missionTokens.sendMissionInvite;

const teamVerification = require('./teamVerification');
exports.payTeamVerification = teamVerification.payTeamVerification;
exports.consumeVerificationMatch = teamVerification.consumeVerificationMatch;
exports.purchaseTeamBackground = teamVerification.purchaseTeamBackground;

const steamStats = require('./steamStats');
exports.getSteamCs2Stats = steamStats.getSteamCs2Stats;

const steamLink = require('./steamLink');
exports.syncSteamIdIndex = steamLink.syncSteamIdIndex;
exports.steamLoginResolve = steamLink.steamLoginResolve;
exports.backfillSteamIndexes = steamLink.backfillSteamIndexes;

const cs2Friends = require('./cs2FriendsMission');
exports.captureCs2Baselines = cs2Friends.captureCs2Baselines;
exports.verifyCs2FriendsMission = cs2Friends.verifyCs2FriendsMission;

const publicProfiles = require('./publicProfiles');
exports.syncPublicProfile = publicProfiles.syncPublicProfile;
exports.backfillPublicProfiles = publicProfiles.backfillPublicProfiles;

const creatorMarket = require('./creatorMarket');
exports.publishCreatorContent = creatorMarket.publishCreatorContent;
exports.rejectCreatorContent = creatorMarket.rejectCreatorContent;
exports.syncCreatorMarketMetrics = creatorMarket.syncCreatorMarketMetrics;

const creatorMarketTrends = require('./creatorMarketTrends');
exports.getCreatorMarketTrends = creatorMarketTrends.getCreatorMarketTrends;
exports.validateCreatorMarketFacebook = creatorMarket.validateCreatorMarketFacebook;
exports.connectFacebookPagePermanent = creatorMarket.connectFacebookPagePermanent;
exports.onCreatorReferralRegistered = creatorMarket.onCreatorReferralRegistered;
exports.refreshMyCreatorMarketMetrics = creatorMarket.refreshMyCreatorMarketMetrics;
exports.syncCreatorMarketMetricsScheduled = creatorMarket.syncCreatorMarketMetricsScheduled;
exports.listCreatorPendingPayouts = creatorMarket.listCreatorPendingPayouts;
exports.approveCreatorPayout = creatorMarket.approveCreatorPayout;

const nexusXp = require('./nexusXp');
exports.awardNexusXp = nexusXp.awardNexusXp;
exports.grantNexusXpCommander = nexusXp.grantNexusXpCommander;
exports.awardReferralBonus = nexusXp.awardReferralBonus;
exports.syncNexusActivityStats = nexusXp.syncNexusActivityStats;
exports.completeNexusDailyLogin = nexusXp.completeNexusDailyLogin;
exports.completeNexusOverlayUpload = nexusXp.completeNexusOverlayUpload;
exports.claimOverlayDownloadXp = nexusXp.claimOverlayDownloadXp;
exports.claimOverlayShareXp = nexusXp.claimOverlayShareXp;
exports.claimOverlayGenerateAiXp = nexusXp.claimOverlayGenerateAiXp;
exports.claimOverlayUseAiXp = nexusXp.claimOverlayUseAiXp;
exports.claimOverlayAnalyzeDesignXp = nexusXp.claimOverlayAnalyzeDesignXp;
exports.registerBrandingStudioSession = nexusXp.registerBrandingStudioSession;
exports.grantNexusXpBoostCommander = nexusXp.grantNexusXpBoostCommander;
exports.onNexusStatsUpdated = nexusXp.onNexusStatsUpdated;
exports.claimNexusReward = nexusXp.claimNexusReward;
exports.checkNexusAchievements = nexusXp.checkNexusAchievements;
exports.completeNexusQuest = nexusXp.completeNexusQuest;
exports.processNexusDailyStreak = nexusXp.processNexusDailyStreak;

const tokenLedger = require('./tokenLedger');
exports.appendTokenLedgerEntry = tokenLedger.appendTokenLedgerEntry;

const refCodes = require('./refCodes');
exports.ensureUserReferralCode = refCodes.ensureUserReferralCode;

const bossOfTheState = require('./bossOfTheState');
exports.claimBossOfTheState = bossOfTheState.claimBossOfTheState;

const teamMembership = require('./teamMembership');
exports.acceptTeamJoinRequest = teamMembership.acceptTeamJoinRequest;
exports.sendTeamInvite = teamMembership.sendTeamInvite;
exports.acceptTeamInvite = teamMembership.acceptTeamInvite;
exports.leaveTeam = teamMembership.leaveTeam;
exports.disbandTeam = teamMembership.disbandTeam;
exports.kickTeamMember = teamMembership.kickTeamMember;

const tournamentInvites = require('./tournamentInvites');
exports.sendTournamentInvite = tournamentInvites.sendTournamentInvite;
exports.cancelTournamentInvite = tournamentInvites.cancelTournamentInvite;

const communityTokens = require('./communityTokens');
exports.awardCommunityForgeUploadTokens = communityTokens.awardCommunityForgeUploadTokens;

const userEconomy = require('./userEconomy');
exports.grantUserInventoryItem = userEconomy.grantUserInventoryItem;
exports.setUserPrestige = userEconomy.setUserPrestige;

const nexusPrivacy = require('./nexusPrivacy');
exports.getNexusLeaderboard = nexusPrivacy.getNexusLeaderboard;
exports.getMyReferralsNexusXp = nexusPrivacy.getMyReferralsNexusXp;
exports.getNexusUserStatsForStaff = nexusPrivacy.getNexusUserStatsForStaff;

const communityReports = require('./communityReports');
exports.submitCommunityReport = communityReports.submitCommunityReport;

const profileCustomizationShop = require('./profileCustomizationShop');
exports.purchaseProfileCustomizationItem = profileCustomizationShop.purchaseProfileCustomizationItem;

const welcomeReward = require('./welcomeReward');
exports.claimWelcomeReward = welcomeReward.claimWelcomeReward;
exports.backfillWelcomeBadge = welcomeReward.backfillWelcomeBadge;
