/**
 * tools/search.ts — Auto-extracted. Add imports manually.
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";

export const google_dorks = tool({
  description:
    "Generate copy-paste Google/Bing/DuckDuckGo/Yandex dork queries for a seed identifier. NO external API cost — always safe to call. Returns a comprehensive, categorized dork menu (60+ queries per kind across breach/pastes, social, code, forums, dark-web-adjacent, docs, archives, public records, etc.). Fire it EARLY and on every newly-discovered high-value artifact (email, username, phone, name, domain, ip, hash, crypto_wallet).",
  inputSchema: z.object({
    seed: z.string(),
    // Accept legacy/alias "person" → mapped to "name" in execute().
    kind: z.enum(["email", "username", "phone", "name", "person", "domain", "ip", "hash", "crypto_wallet"]),
  }),
  execute: async ({ seed, kind: rawKind }) => {
    const kind = rawKind === "person" ? "name" : rawKind;
    // google_dorks is intentionally ungated — it only emits search URLs.
    const e = encodeURIComponent(seed);
    const map: Record<string, Array<{ category: string; query: string; url: string }>> = {
      email: [
        { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
        { category: "Direct", query: `intext:"${seed}"`, url: `https://www.google.com/search?q=intext:%22${e}%22` },
        { category: "Direct", query: `"${seed}" "@"`, url: `https://www.google.com/search?q=%22${e}%22+%22@%22` },
        { category: "Leaks/Pastebins", query: `"${seed}" site:pastebin.com OR site:pastie.org OR site:paste.ubuntu.com OR site:paste.debian.net`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com+OR+site:pastie.org+OR+site:paste.ubuntu.com` },
        { category: "Leaks/Pastebins", query: `"${seed}" site:controlc.com OR site:dpaste.com OR site:ideone.com OR site:rentry.co`, url: `https://www.google.com/search?q=%22${e}%22+site:controlc.com+OR+site:dpaste.com+OR+site:rentry.co` },
        { category: "Leaks/Pastebins", query: `"${seed}" "password" OR "pass" OR "passwd" filetype:txt OR filetype:log`, url: `https://www.google.com/search?q=%22${e}%22+%22password%22+filetype:txt` },
        { category: "Leaks/Pastebins", query: `"${seed}" intitle:"index of" "email" OR "users" OR "accounts"`, url: `https://www.google.com/search?q=%22${e}%22+intitle:%22index+of%22+%22email%22` },
        { category: "Code/Git", query: `"${seed}" site:github.com OR site:gitlab.com OR site:bitbucket.org`, url: `https://www.google.com/search?q=%22${e}%22+site:github.com+OR+site:gitlab.com` },
        { category: "Code/Git", query: `"${seed}" site:gist.github.com OR site:gists.github.com`, url: `https://www.google.com/search?q=%22${e}%22+site:gist.github.com` },
        { category: "Code/Git", query: `"${seed}" "config" "email" filetype:json OR filetype:xml OR filetype:yaml OR filetype:yml`, url: `https://www.google.com/search?q=%22${e}%22+%22config%22+filetype:json` },
        { category: "Social", query: `"${seed}" site:reddit.com OR site:old.reddit.com`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com` },
        { category: "Social", query: `"${seed}" site:twitter.com OR site:x.com OR site:tweetdeck.twitter.com`, url: `https://www.google.com/search?q=%22${e}%22+site:twitter.com` },
        { category: "Social", query: `"${seed}" site:linkedin.com/in OR site:linkedin.com/pub`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com/in` },
        { category: "Social", query: `"${seed}" site:instagram.com OR site:pinterest.com OR site:tumblr.com`, url: `https://www.google.com/search?q=%22${e}%22+site:instagram.com` },
        { category: "Forums", query: `"${seed}" site:forum OR site:boards OR site:community`, url: `https://www.google.com/search?q=%22${e}%22+site:forum` },
        { category: "Forums", query: `"${seed}" site:hackforums.net OR site:breachforums.is OR site:nulled.to`, url: `https://www.google.com/search?q=%22${e}%22+site:hackforums.net` },
        { category: "Documents", query: `"${seed}" filetype:pdf OR filetype:doc OR filetype:docx OR filetype:rtf`, url: `https://www.google.com/search?q=%22${e}%22+filetype:pdf` },
        { category: "Documents", query: `"${seed}" filetype:xls OR filetype:xlsx OR filetype:csv`, url: `https://www.google.com/search?q=%22${e}%22+filetype:xls` },
        { category: "Documents", query: `"${seed}" ext:sql OR ext:db OR ext:backup OR ext:bak`, url: `https://www.google.com/search?q=%22${e}%22+ext:sql` },
        { category: "Documents", query: `"${seed}" intitle:"database" OR intitle:"backup" OR intitle:"dump"`, url: `https://www.google.com/search?q=%22${e}%22+intitle:%22database%22` },
        { category: "Caches/Archives", query: `"${seed}" site:webcache.googleusercontent.com OR site:web.archive.org`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
        { category: "Caches/Archives", query: `cache:"${seed}"`, url: `https://webcache.googleusercontent.com/search?q=cache:${e}` },
        { category: "Breaches", query: `"${seed}" "breach" OR "leaked" OR "database" OR "combo list"`, url: `https://www.google.com/search?q=%22${e}%22+%22breach%22` },
        { category: "Breaches", query: `"${seed}" "haveibeenpwned" OR "dehashed" OR "snusbase" OR "leakcheck"`, url: `https://www.google.com/search?q=%22${e}%22+%22haveibeenpwned%22` },
        { category: "WHOIS/RDAP", query: `"${seed}" site:whois.com OR site:whois.domaintools.com OR site:who.is`, url: `https://www.google.com/search?q=%22${e}%22+site:whois.com` },
        { category: "Images/Media", query: `"${seed}" site:imgur.com OR site:flickr.com OR site:photobucket.com`, url: `https://www.google.com/search?q=%22${e}%22+site:imgur.com` },
        { category: "Images/Media", query: `"${seed}" site:youtube.com OR site:vimeo.com OR site:dailymotion.com`, url: `https://www.google.com/search?q=%22${e}%22+site:youtube.com` },
        { category: "Resumes/CVs", query: `"${seed}" "resume" OR "cv" OR "curriculum vitae" filetype:pdf OR filetype:doc`, url: `https://www.google.com/search?q=%22${e}%22+%22resume%22+filetype:pdf` },
        { category: "Resumes/CVs", query: `"${seed}" "portfolio" OR "about me" OR "contact"`, url: `https://www.google.com/search?q=%22${e}%22+%22portfolio%22` },
        { category: "OSINT Tools", query: `"${seed}" site:osint.org OR site:osintcurious.io OR site:osintframework.com`, url: `https://www.google.com/search?q=%22${e}%22+site:osint.org` },
        { category: "Public Records", query: `"${seed}" site:opencorporates.com OR site:bizapedia.com OR site:manta.com`, url: `https://www.google.com/search?q=%22${e}%22+site:opencorporates.com` },
        { category: "Public Records", query: `"${seed}" site:crunchbase.com OR site:angel.co OR site:wellfound.com`, url: `https://www.google.com/search?q=%22${e}%22+site:crunchbase.com` },
        { category: "Public Records", query: `"${seed}" site:opencalais.com OR site:alexa.com OR site:builtwith.com`, url: `https://www.google.com/search?q=%22${e}%22+site:builtwith.com` },
        { category: "Pastes/Leaks", query: `"${seed}" site:ghostbin.co OR site:hastebin.com OR site:0bin.net OR site:privatebin.info`, url: `https://www.google.com/search?q=%22${e}%22+site:ghostbin.co+OR+site:hastebin.com` },
        { category: "Pastes/Leaks", query: `"${seed}" site:justpaste.it OR site:paste.ee OR site:bpaste.net OR site:termbin.com`, url: `https://www.google.com/search?q=%22${e}%22+site:justpaste.it+OR+site:paste.ee` },
        { category: "Pastes/Leaks", query: `"${seed}" "combo" OR "combolist" OR "stealer" OR "redline" OR "raccoon"`, url: `https://www.google.com/search?q=%22${e}%22+%22combolist%22+OR+%22stealer%22` },
        { category: "Stealer Logs", query: `"${seed}" "passwords.txt" OR "credentials.txt" OR "logins.txt"`, url: `https://www.google.com/search?q=%22${e}%22+%22passwords.txt%22+OR+%22credentials.txt%22` },
        { category: "Stealer Logs", query: `"${seed}" "autofill" OR "cookies.txt" OR "wallets.txt"`, url: `https://www.google.com/search?q=%22${e}%22+%22autofill%22+OR+%22cookies.txt%22` },
        { category: "Dark-web Adjacent", query: `"${seed}" site:dread.onion OR site:darkfailllnkf4vf.onion OR "dark web" "marketplace"`, url: `https://www.google.com/search?q=%22${e}%22+%22dark+web%22+%22marketplace%22` },
        { category: "Dark-web Adjacent", query: `"${seed}" site:tor.taxi OR site:darknetlive.com OR site:tor.link`, url: `https://www.google.com/search?q=%22${e}%22+site:darknetlive.com` },
        { category: "Telegram", query: `"${seed}" site:t.me OR site:telegram.me OR site:telegramchannels.me`, url: `https://www.google.com/search?q=%22${e}%22+site:t.me+OR+site:telegram.me` },
        { category: "Telegram", query: `"${seed}" "telegram" "channel" OR "group" OR "@"`, url: `https://www.google.com/search?q=%22${e}%22+%22telegram%22+%22channel%22` },
        { category: "Discord", query: `"${seed}" site:discord.com OR site:discord.gg OR site:disboard.org OR site:top.gg`, url: `https://www.google.com/search?q=%22${e}%22+site:discord.gg+OR+site:disboard.org` },
        { category: "Federated Social", query: `"${seed}" site:bsky.app OR site:bsky.social OR site:mastodon.social OR site:threads.net`, url: `https://www.google.com/search?q=%22${e}%22+site:bsky.app+OR+site:mastodon.social` },
        { category: "Federated Social", query: `"${seed}" site:lemmy.world OR site:kbin.social OR site:pixelfed.social`, url: `https://www.google.com/search?q=%22${e}%22+site:lemmy.world+OR+site:pixelfed.social` },
        { category: "Adult/Cam", query: `"${seed}" site:onlyfans.com OR site:fansly.com OR site:manyvids.com OR site:chaturbate.com`, url: `https://www.google.com/search?q=%22${e}%22+site:onlyfans.com+OR+site:fansly.com` },
        { category: "Payment Handles", query: `"${seed}" site:cash.app OR site:venmo.com OR site:paypal.me OR site:account.venmo.com`, url: `https://www.google.com/search?q=%22${e}%22+site:cash.app+OR+site:venmo.com` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
        { category: "Education", query: `"${seed}" site:edu OR site:ac.uk OR site:edu.au`, url: `https://www.google.com/search?q=%22${e}%22+site:edu+OR+site:ac.uk` },
        { category: "Dating", query: `"${seed}" site:tinder.com OR site:bumble.com OR site:okcupid.com OR site:hinge.co`, url: `https://www.google.com/search?q=%22${e}%22+site:tinder.com+OR+site:hinge.co` },
      ],
      username: [
        { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
        { category: "Direct", query: `intext:"${seed}"`, url: `https://www.google.com/search?q=intext:%22${e}%22` },
        { category: "Direct", query: `"@${seed}"`, url: `https://www.google.com/search?q=%22%40${e}%22` },
        { category: "Social", query: `"${seed}" site:reddit.com/user/${seed} OR site:reddit.com/u/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com/user/${e}` },
        { category: "Social", query: `"${seed}" site:twitter.com/${seed} OR site:x.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:twitter.com/${e}` },
        { category: "Social", query: `"${seed}" site:instagram.com/${seed} OR site:instagram.com/${seed}/`, url: `https://www.google.com/search?q=%22${e}%22+site:instagram.com/${e}` },
        { category: "Social", query: `"${seed}" site:tiktok.com/@${seed} OR site:tiktok.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:tiktok.com/@${e}` },
        { category: "Social", query: `"${seed}" site:linkedin.com/in OR site:linkedin.com/pub`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com/in` },
        { category: "Social", query: `"${seed}" site:facebook.com/${seed} OR site:fb.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:facebook.com/${e}` },
        { category: "Social", query: `"${seed}" site:discord.com OR site:discord.gg OR site:disboard.org`, url: `https://www.google.com/search?q=%22${e}%22+site:discord.com` },
        { category: "Code/Dev", query: `"${seed}" site:github.com/${seed} OR site:gitlab.com/${seed} OR site:bitbucket.org/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:github.com/${e}` },
        { category: "Code/Dev", query: `"${seed}" site:stackoverflow.com/users OR site:stackexchange.com/users`, url: `https://www.google.com/search?q=%22${e}%22+site:stackoverflow.com/users` },
        { category: "Code/Dev", query: `"${seed}" site:dev.to/${seed} OR site:hashnode.com/@${seed} OR site:medium.com/@${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:dev.to/${e}` },
        { category: "Code/Dev", query: `"${seed}" site:hackerrank.com/${seed} OR site:leetcode.com/${seed} OR site:codewars.com/users/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:hackerrank.com/${e}` },
        { category: "Gaming", query: `"${seed}" site:steamcommunity.com/id/${seed} OR site:steamcommunity.com/profiles`, url: `https://www.google.com/search?q=%22${e}%22+site:steamcommunity.com/id/${e}` },
        { category: "Gaming", query: `"${seed}" site:twitch.tv/${seed} OR site:youtube.com/@${seed} OR site:youtube.com/c/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:twitch.tv/${e}` },
        { category: "Gaming", query: `"${seed}" site:roblox.com/users OR site:roblox.com/user`, url: `https://www.google.com/search?q=%22${e}%22+site:roblox.com/users` },
        { category: "Creative", query: `"${seed}" site:behance.net/${seed} OR site:dribbble.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:behance.net/${e}` },
        { category: "Creative", query: `"${seed}" site:flickr.com/people/${seed} OR site:500px.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:flickr.com/people/${e}` },
        { category: "Creative", query: `"${seed}" site:vimeo.com/${seed} OR site:soundcloud.com/${seed} OR site:bandcamp.com`, url: `https://www.google.com/search?q=%22${e}%22+site:soundcloud.com/${e}` },
        { category: "Forums", query: `"${seed}" site:hackforums.net OR site:breachforums.is OR site:cracked.io OR site:nulled.to`, url: `https://www.google.com/search?q=%22${e}%22+site:hackforums.net` },
        { category: "Forums", query: `"${seed}" site:forum.onion OR site:boards.4chan.org OR site:8kun.top`, url: `https://www.google.com/search?q=%22${e}%22+site:boards.4chan.org` },
        { category: "Leaks/Pastebins", query: `"${seed}" site:pastebin.com OR site:pastie.org OR site:rentry.co`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com` },
        { category: "Leaks/Pastebins", query: `"${seed}" filetype:log OR filetype:txt OR filetype:csv "password" OR "email"`, url: `https://www.google.com/search?q=%22${e}%22+filetype:log+%22password%22` },
        { category: "Documents", query: `"${seed}" filetype:pdf OR filetype:doc OR filetype:docx`, url: `https://www.google.com/search?q=%22${e}%22+filetype:pdf` },
        { category: "Documents", query: `"${seed}" "resume" OR "cv" OR "portfolio" filetype:pdf`, url: `https://www.google.com/search?q=%22${e}%22+%22resume%22+filetype:pdf` },
        { category: "Documents", query: `"${seed}" "about me" OR "contact" OR "bio"`, url: `https://www.google.com/search?q=%22${e}%22+%22about+me%22` },
        { category: "WHOIS/Domain", query: `"${seed}" site:who.is OR site:whois.com OR site:whois.domaintools.com`, url: `https://www.google.com/search?q=%22${e}%22+site:who.is` },
        { category: "Caches", query: `cache:"${seed}"`, url: `https://webcache.googleusercontent.com/search?q=cache:${e}` },
        { category: "Caches", query: `"${seed}" site:web.archive.org OR site:archive.is OR site:archive.org`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
        { category: "Keybase/Crypto", query: `"${seed}" site:keybase.io/${seed} OR site:keybase.pub/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:keybase.io/${e}` },
        { category: "Keybase/Crypto", query: `"${seed}" site:keys.openpgp.org OR site:pgp.mit.edu OR site:pool.sks-keyservers.net`, url: `https://www.google.com/search?q=%22${e}%22+site:keys.openpgp.org` },
        { category: "OSINT Aggregators", query: `"${seed}" site:osint.org OR site:osintcurious.io OR site:osintframework.com`, url: `https://www.google.com/search?q=%22${e}%22+site:osint.org` },
        { category: "OSINT Aggregators", query: `"${seed}" site:whatsmyname.app OR site:sherlock-project.xyz OR site:namechk.com`, url: `https://www.google.com/search?q=%22${e}%22+site:whatsmyname.app` },
        { category: "Telegram", query: `"${seed}" site:t.me/${seed} OR site:telegram.me/${seed} OR site:tgstat.com/en/channel/@${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:t.me/${e}` },
        { category: "Telegram", query: `"@${seed}" site:t.me OR site:telegram.me OR site:telegramindex.com`, url: `https://www.google.com/search?q=%22%40${e}%22+site:t.me` },
        { category: "Federated Social", query: `"${seed}" site:bsky.app/profile/${seed} OR site:bsky.app/profile/${seed}.bsky.social`, url: `https://www.google.com/search?q=site:bsky.app/profile/${e}` },
        { category: "Federated Social", query: `"@${seed}" site:mastodon.social OR site:mastodon.online OR site:hachyderm.io OR site:infosec.exchange`, url: `https://www.google.com/search?q=%22%40${e}%22+site:mastodon.social` },
        { category: "Federated Social", query: `"${seed}" site:threads.net/@${seed}`, url: `https://www.google.com/search?q=site:threads.net/@${e}` },
        { category: "Federated Social", query: `"${seed}" site:lemmy.world/u/${seed} OR site:kbin.social/u/${seed}`, url: `https://www.google.com/search?q=site:lemmy.world/u/${e}` },
        { category: "Adult/Cam", query: `"${seed}" site:onlyfans.com/${seed} OR site:fansly.com/${seed} OR site:manyvids.com OR site:chaturbate.com/${seed}`, url: `https://www.google.com/search?q=site:onlyfans.com/${e}+OR+site:fansly.com/${e}` },
        { category: "Adult/Cam", query: `"${seed}" site:pornhub.com/users/${seed} OR site:xvideos.com/profiles/${seed}`, url: `https://www.google.com/search?q=site:pornhub.com/users/${e}` },
        { category: "Payment Handles", query: `"${seed}" site:cash.app/$${seed} OR site:venmo.com/u/${seed} OR site:paypal.me/${seed}`, url: `https://www.google.com/search?q=site:cash.app/%24${e}+OR+site:venmo.com/u/${e}+OR+site:paypal.me/${e}` },
        { category: "Payment Handles", query: `"${seed}" "cashapp" OR "$cashtag" OR "venmo" OR "zelle" OR "paypal"`, url: `https://www.google.com/search?q=%22${e}%22+%22cashapp%22+OR+%22venmo%22+OR+%22zelle%22` },
        { category: "Stealer Logs", query: `"${seed}" "passwords" OR "logins" OR "autofill" filetype:txt`, url: `https://www.google.com/search?q=%22${e}%22+%22passwords%22+filetype:txt` },
        { category: "Stealer Logs", query: `"${seed}" "redline" OR "raccoon" OR "vidar" OR "lumma" OR "stealer log"`, url: `https://www.google.com/search?q=%22${e}%22+%22redline%22+OR+%22stealer+log%22` },
        { category: "Dark-web Adjacent", query: `"${seed}" site:dread.onion OR site:tor.taxi OR site:darknetlive.com`, url: `https://www.google.com/search?q=%22${e}%22+site:darknetlive.com` },
        { category: "Marketplaces", query: `"${seed}" site:ebay.com OR site:depop.com OR site:poshmark.com OR site:mercari.com`, url: `https://www.google.com/search?q=%22${e}%22+site:depop.com+OR+site:poshmark.com` },
        { category: "Marketplaces", query: `"${seed}" site:etsy.com OR site:fiverr.com OR site:upwork.com/freelancers`, url: `https://www.google.com/search?q=%22${e}%22+site:fiverr.com+OR+site:upwork.com` },
        { category: "Gaming", query: `"${seed}" site:battle.net OR site:epicgames.com OR site:xbox.com/en-us/play/user/${seed} OR site:psnprofiles.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:psnprofiles.com/${e}` },
        { category: "Gaming", query: `"${seed}" site:tracker.gg OR site:op.gg OR site:lolprofile.net OR site:dotabuff.com`, url: `https://www.google.com/search?q=%22${e}%22+site:tracker.gg+OR+site:op.gg` },
        { category: "Crypto", query: `"${seed}" site:keybase.io OR site:warpcast.com OR site:lens.xyz OR site:farcaster.xyz`, url: `https://www.google.com/search?q=%22${e}%22+site:warpcast.com+OR+site:lens.xyz` },
        { category: "Crypto", query: `"${seed}" "ens" OR ".eth" OR "wallet" OR "address"`, url: `https://www.google.com/search?q=%22${e}%22+%22.eth%22+OR+%22wallet%22` },
        { category: "Pastes/Leaks", query: `"${seed}" site:ghostbin.co OR site:hastebin.com OR site:0bin.net OR site:justpaste.it`, url: `https://www.google.com/search?q=%22${e}%22+site:ghostbin.co+OR+site:justpaste.it` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
      ],
      phone: [
        { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
        { category: "Direct", query: `intext:"${seed}"`, url: `https://www.google.com/search?q=intext:%22${e}%22` },
        { category: "Social", query: `"${seed}" site:facebook.com OR site:fb.com`, url: `https://www.google.com/search?q=%22${e}%22+site:facebook.com` },
        { category: "Social", query: `"${seed}" site:linkedin.com/in OR site:linkedin.com/pub`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com/in` },
        { category: "Social", query: `"${seed}" site:twitter.com OR site:x.com`, url: `https://www.google.com/search?q=%22${e}%22+site:twitter.com` },
        { category: "Social", query: `"${seed}" site:instagram.com OR site:reddit.com`, url: `https://www.google.com/search?q=%22${e}%22+site:instagram.com` },
        { category: "Business", query: `"${seed}" site:yelp.com OR site:yellowpages.com OR site:bbb.org`, url: `https://www.google.com/search?q=%22${e}%22+site:yelp.com` },
        { category: "Business", query: `"${seed}" site:manta.com OR site:superpages.com OR site:chamberofcommerce.com`, url: `https://www.google.com/search?q=%22${e}%22+site:manta.com` },
        { category: "Business", query: `"${seed}" site:opencorporates.com OR site:bizapedia.com OR site:dnb.com`, url: `https://www.google.com/search?q=%22${e}%22+site:opencorporates.com` },
        { category: "Directories", query: `"${seed}" site:whitepages.com OR site:spokeo.com OR site:beenverified.com`, url: `https://www.google.com/search?q=%22${e}%22+site:whitepages.com` },
        { category: "Directories", query: `"${seed}" site:intelius.com OR site:peekyou.com OR site:pipl.com`, url: `https://www.google.com/search?q=%22${e}%22+site:intelius.com` },
        { category: "Forums/Marketplaces", query: `"${seed}" site:craigslist.org OR site:offerup.com OR site:letgo.com`, url: `https://www.google.com/search?q=%22${e}%22+site:craigslist.org` },
        { category: "Forums/Marketplaces", query: `"${seed}" site:ebay.com OR site:amazon.com OR site:etsy.com`, url: `https://www.google.com/search?q=%22${e}%22+site:ebay.com` },
        { category: "Leaks", query: `"${seed}" filetype:txt OR filetype:csv OR filetype:pdf "phone" OR "contact"`, url: `https://www.google.com/search?q=%22${e}%22+filetype:txt+%22phone%22` },
        { category: "Leaks", query: `"${seed}" site:pastebin.com OR site:rentry.co OR site:controlc.com`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com` },
        { category: "Documents", query: `"${seed}" filetype:pdf OR filetype:doc OR filetype:docx`, url: `https://www.google.com/search?q=%22${e}%22+filetype:pdf` },
        { category: "Documents", query: `"${seed}" "resume" OR "cv" OR "contact" filetype:pdf`, url: `https://www.google.com/search?q=%22${e}%22+%22resume%22+filetype:pdf` },
        { category: "Public Records", query: `"${seed}" site:courtlistener.com OR site:justia.com OR site:findlaw.com`, url: `https://www.google.com/search?q=%22${e}%22+site:courtlistener.com` },
        { category: "Public Records", query: `"${seed}" site:gov OR site:gov.uk OR site:europa.eu`, url: `https://www.google.com/search?q=%22${e}%22+site:gov` },
        { category: "Caches", query: `"${seed}" site:web.archive.org OR site:archive.is`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
        { category: "Messaging Handles", query: `"${seed}" site:t.me OR site:telegram.me OR "telegram" "contact"`, url: `https://www.google.com/search?q=%22${e}%22+site:t.me+OR+%22telegram%22+%22contact%22` },
        { category: "Messaging Handles", query: `"${seed}" "whatsapp" OR "wa.me" OR "signal" OR "viber"`, url: `https://www.google.com/search?q=%22${e}%22+%22whatsapp%22+OR+%22wa.me%22+OR+%22signal%22` },
        { category: "Reverse Lookup", query: `"${seed}" site:truecaller.com OR site:nuwber.com OR site:radaris.com OR site:fastpeoplesearch.com`, url: `https://www.google.com/search?q=%22${e}%22+site:truecaller.com+OR+site:fastpeoplesearch.com` },
        { category: "Reverse Lookup", query: `"${seed}" site:thatsthem.com OR site:usphonebook.com OR site:411.com OR site:zabasearch.com`, url: `https://www.google.com/search?q=%22${e}%22+site:thatsthem.com+OR+site:411.com` },
        { category: "Scam Reports", query: `"${seed}" site:800notes.com OR site:whocallsme.com OR site:reportedcall.com OR site:nomorobo.com`, url: `https://www.google.com/search?q=%22${e}%22+site:800notes.com+OR+site:whocallsme.com` },
        { category: "Scam Reports", query: `"${seed}" "scam" OR "spam" OR "fraud" OR "robocall"`, url: `https://www.google.com/search?q=%22${e}%22+%22scam%22+OR+%22robocall%22` },
        { category: "Dating", query: `"${seed}" site:tinder.com OR site:bumble.com OR site:hinge.co OR site:okcupid.com`, url: `https://www.google.com/search?q=%22${e}%22+site:tinder.com+OR+site:hinge.co` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
      ],
      name: [
        { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
        { category: "Direct", query: `intext:"${seed}"`, url: `https://www.google.com/search?q=intext:%22${e}%22` },
        { category: "LinkedIn", query: `"${seed}" site:linkedin.com/in`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com/in` },
        { category: "LinkedIn", query: `"${seed}" "linkedin"`, url: `https://www.google.com/search?q=%22${e}%22+%22linkedin%22` },
        { category: "Social", query: `"${seed}" site:facebook.com OR site:fb.com`, url: `https://www.google.com/search?q=%22${e}%22+site:facebook.com` },
        { category: "Social", query: `"${seed}" site:twitter.com OR site:x.com OR site:instagram.com`, url: `https://www.google.com/search?q=%22${e}%22+site:twitter.com` },
        { category: "Documents", query: `"${seed}" filetype:pdf OR filetype:doc`, url: `https://www.google.com/search?q=%22${e}%22+filetype:pdf` },
        { category: "Documents", query: `"${seed}" "resume" OR "cv" filetype:pdf`, url: `https://www.google.com/search?q=%22${e}%22+%22resume%22+filetype:pdf` },
        { category: "Documents", query: `"${seed}" "portfolio" OR "about me" OR "contact"`, url: `https://www.google.com/search?q=%22${e}%22+%22portfolio%22` },
        { category: "Public Records", query: `"${seed}" site:whitepages.com OR site:spokeo.com OR site:intelius.com`, url: `https://www.google.com/search?q=%22${e}%22+site:whitepages.com` },
        { category: "Public Records", query: `"${seed}" site:opencorporates.com OR site:crunchbase.com OR site:bizapedia.com`, url: `https://www.google.com/search?q=%22${e}%22+site:opencorporates.com` },
        { category: "Public Records", query: `"${seed}" site:gov OR site:gov.uk OR site:europa.eu`, url: `https://www.google.com/search?q=%22${e}%22+site:gov` },
        { category: "Public Records", query: `"${seed}" site:courtlistener.com OR site:justia.com OR site:pacer.gov`, url: `https://www.google.com/search?q=%22${e}%22+site:courtlistener.com` },
        { category: "Public Records", query: `"${seed}" "address" OR "phone" OR "email"`, url: `https://www.google.com/search?q=%22${e}%22+%22address%22+%22phone%22` },
        { category: "Images", query: `"${seed}" site:imgur.com OR site:flickr.com OR site:photobucket.com`, url: `https://www.google.com/search?q=%22${e}%22+site:imgur.com` },
        { category: "Images", query: `"${seed}" site:youtube.com OR site:vimeo.com OR site:dailymotion.com`, url: `https://www.google.com/search?q=%22${e}%22+site:youtube.com` },
        { category: "News", query: `"${seed}" site:news.google.com OR site:bing.com/news`, url: `https://www.google.com/search?q=%22${e}%22+site:news.google.com` },
        { category: "News", query: `"${seed}" "news" OR "article" OR "interview"`, url: `https://www.google.com/search?q=%22${e}%22+%22news%22` },
        { category: "Forums", query: `"${seed}" site:reddit.com OR site:quora.com OR site:stackexchange.com`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com` },
        { category: "Forums", query: `"${seed}" site:medium.com OR site:substack.com OR site:ghost.io`, url: `https://www.google.com/search?q=%22${e}%22+site:medium.com` },
        { category: "Caches", query: `"${seed}" site:web.archive.org OR site:archive.is`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
        { category: "Obituaries/Genealogy", query: `"${seed}" site:legacy.com OR site:findagrave.com OR site:ancestry.com OR site:familysearch.org`, url: `https://www.google.com/search?q=%22${e}%22+site:legacy.com+OR+site:findagrave.com` },
        { category: "Obituaries/Genealogy", query: `"${seed}" "obituary" OR "in memoriam" OR "memorial"`, url: `https://www.google.com/search?q=%22${e}%22+%22obituary%22` },
        { category: "Political/Donations", query: `"${seed}" site:fec.gov OR site:opensecrets.org OR site:followthemoney.org`, url: `https://www.google.com/search?q=%22${e}%22+site:fec.gov+OR+site:opensecrets.org`},
        { category: "Political/Donations", query: `"${seed}" "donor" OR "campaign contribution" OR "PAC"`, url: `https://www.google.com/search?q=%22${e}%22+%22donor%22+%22campaign%22` },
        { category: "Property/Real Estate", query: `"${seed}" site:zillow.com OR site:realtor.com OR site:redfin.com OR site:trulia.com`, url: `https://www.google.com/search?q=%22${e}%22+site:zillow.com+OR+site:realtor.com` },
        { category: "Property/Real Estate", query: `"${seed}" "deed" OR "property record" OR "assessor" OR "tax record"`, url: `https://www.google.com/search?q=%22${e}%22+%22deed%22+OR+%22property+record%22` },
        { category: "Sex Offender / Mugshots", query: `"${seed}" site:nsopw.gov OR site:mugshots.com OR site:bustedmugshots.com`, url: `https://www.google.com/search?q=%22${e}%22+site:nsopw.gov+OR+site:mugshots.com` },
        { category: "Patents/Academic", query: `"${seed}" site:patents.google.com OR site:scholar.google.com OR site:orcid.org`, url: `https://www.google.com/search?q=%22${e}%22+site:patents.google.com+OR+site:scholar.google.com` },
        { category: "People Search", query: `"${seed}" site:peoplefinders.com OR site:beenverified.com OR site:truthfinder.com OR site:instantcheckmate.com`, url: `https://www.google.com/search?q=%22${e}%22+site:peoplefinders.com+OR+site:beenverified.com` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
      ],
      domain: [
        { category: "Direct", query: `site:${seed}`, url: `https://www.google.com/search?q=site:${e}` },
        { category: "Exposed Files", query: `site:${seed} ext:env OR ext:log OR ext:bak OR ext:sql OR ext:dump OR ext:backup`, url: `https://www.google.com/search?q=site:${e}+ext:env+OR+ext:log+OR+ext:bak` },
        { category: "Exposed Files", query: `site:${seed} ext:json OR ext:xml OR ext:yaml OR ext:yml OR ext:config`, url: `https://www.google.com/search?q=site:${e}+ext:json+OR+ext:xml+OR+ext:config` },
        { category: "Exposed Files", query: `site:${seed} filetype:sql "password" OR "secret" OR "api_key" OR "token"`, url: `https://www.google.com/search?q=site:${e}+filetype:sql+%22password%22` },
        { category: "Exposed Files", query: `site:${seed} "config" "database" "password" ext:php OR ext:py OR ext:rb`, url: `https://www.google.com/search?q=site:${e}+%22config%22+%22database%22+ext:php` },
        { category: "Directory Listings", query: `site:${seed} intitle:"index of"`, url: `https://www.google.com/search?q=site:${e}+intitle:%22index+of%22` },
        { category: "Directory Listings", query: `site:${seed} intitle:"index of" "config" OR "backup" OR "database"`, url: `https://www.google.com/search?q=site:${e}+intitle:%22index+of%22+%22config%22` },
        { category: "Directory Listings", query: `site:${seed} intitle:"index of" ext:sql OR ext:db OR ext:sqlite`, url: `https://www.google.com/search?q=site:${e}+intitle:%22index+of%22+ext:sql` },
        { category: "Git/SVN", query: `site:${seed} inurl:.git OR inurl:.svn OR inurl:.hg`, url: `https://www.google.com/search?q=site:${e}+inurl:.git+OR+inurl:.svn` },
        { category: "Git/SVN", query: `site:${seed} "GITHUB_TOKEN" OR "AWS_ACCESS_KEY_ID" OR "PRIVATE KEY"`, url: `https://www.google.com/search?q=site:${e}+%22GITHUB_TOKEN%22+OR+%22AWS_ACCESS_KEY_ID%22` },
        { category: "Git/SVN", query: `site:${seed} "-----BEGIN RSA PRIVATE KEY-----" OR "-----BEGIN OPENSSH PRIVATE KEY-----"`, url: `https://www.google.com/search?q=site:${e}+%22-----BEGIN+RSA+PRIVATE+KEY-----` },
        { category: "Admin Panels", query: `site:${seed} inurl:admin OR inurl:administrator OR inurl:login OR inurl:signin`, url: `https://www.google.com/search?q=site:${e}+inurl:admin+OR+inurl:login` },
        { category: "Admin Panels", query: `site:${seed} intitle:"login" "admin" OR "cpanel" OR "webmail"`, url: `https://www.google.com/search?q=site:${e}+intitle:%22login%22+%22admin%22` },
        { category: "Admin Panels", query: `site:${seed} inurl:phpmyadmin OR inurl:wp-admin OR inurl:wp-login`, url: `https://www.google.com/search?q=site:${e}+inurl:phpmyadmin+OR+inurl:wp-admin` },
        { category: "API/Endpoints", query: `site:${seed} inurl:api OR inurl:swagger OR inurl:graphql OR inurl:rest`, url: `https://www.google.com/search?q=site:${e}+inurl:api+OR+inurl:swagger` },
        { category: "API/Endpoints", query: `site:${seed} "api_key" OR "api_secret" OR "client_id" OR "client_secret"`, url: `https://www.google.com/search?q=site:${e}+%22api_key%22+OR+%22api_secret%22` },
        { category: "API/Endpoints", query: `site:${seed} ext:wsdl OR ext:wadl OR ext:raml`, url: `https://www.google.com/search?q=site:${e}+ext:wsdl+OR+ext:wadl` },
        { category: "CMS/WP", query: `site:${seed} inurl:wp-content OR inurl:wp-includes`, url: `https://www.google.com/search?q=site:${e}+inurl:wp-content` },
        { category: "CMS/WP", query: `site:${seed} "wp-config.php" OR "wp-config.php.bak" OR "wp-config.php~"`, url: `https://www.google.com/search?q=site:${e}+%22wp-config.php%22` },
        { category: "CMS/WP", query: `site:${seed} inurl:wp-json/wp/v2/users`, url: `https://www.google.com/search?q=site:${e}+inurl:wp-json/wp/v2/users` },
        { category: "Subdomains", query: `site:*.${seed} -www`, url: `https://www.google.com/search?q=site:*.${e}+-www` },
        { category: "Subdomains", query: `site:${seed} -inurl:www`, url: `https://www.google.com/search?q=site:${e}+-inurl:www` },
        { category: "Subdomains", query: `site:*.${seed} ext:pdf OR ext:doc`, url: `https://www.google.com/search?q=site:*.${e}+ext:pdf` },
        { category: "Off-domain Mentions", query: `"${seed}" -site:${seed}`, url: `https://www.google.com/search?q=%22${e}%22+-site:${e}` },
        { category: "Off-domain Mentions", query: `"${seed}" "breach" OR "leaked" OR "database"`, url: `https://www.google.com/search?q=%22${e}%22+%22breach%22` },
        { category: "Off-domain Mentions", query: `"${seed}" site:shodan.io OR site:censys.io OR site:spyse.com`, url: `https://www.google.com/search?q=%22${e}%22+site:shodan.io` },
        { category: "SSL/Certs", query: `site:${seed} "BEGIN CERTIFICATE" OR "END CERTIFICATE"`, url: `https://www.google.com/search?q=site:${e}+%22BEGIN+CERTIFICATE%22` },
        { category: "SSL/Certs", query: `site:${seed} ext:crt OR ext:pem OR ext:cer`, url: `https://www.google.com/search?q=site:${e}+ext:crt+OR+ext:pem` },
        { category: "Whois/RDAP", query: `"${seed}" site:whois.com OR site:whois.domaintools.com OR site:who.is`, url: `https://www.google.com/search?q=%22${e}%22+site:whois.com` },
        { category: "Wayback", query: `"${seed}" site:web.archive.org OR site:archive.is`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
        { category: "Employees/Team", query: `"${seed}" "team" OR "about us" OR "staff" OR "employees"`, url: `https://www.google.com/search?q=%22${e}%22+%22team%22+%22about+us%22` },
        { category: "Employees/Team", query: `"${seed}" site:linkedin.com "works at" OR "employed at"`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com+%22works+at%22` },
        { category: "Documents", query: `site:${seed} filetype:pdf OR filetype:doc OR filetype:docx OR filetype:ppt OR filetype:pptx`, url: `https://www.google.com/search?q=site:${e}+filetype:pdf` },
        { category: "Documents", query: `site:${seed} filetype:xls OR filetype:xlsx OR filetype:csv`, url: `https://www.google.com/search?q=site:${e}+filetype:xls` },
        { category: "Documents", query: `site:${seed} "confidential" OR "internal use only" OR "proprietary" filetype:pdf`, url: `https://www.google.com/search?q=site:${e}+%22confidential%22+filetype:pdf` },
        { category: "S3/Buckets", query: `site:${seed} "s3.amazonaws.com" OR "s3://" OR "bucket"`, url: `https://www.google.com/search?q=site:${e}+%22s3.amazonaws.com%22` },
        { category: "S3/Buckets", query: `site:${seed} "cloudfront.net" OR "gcs" OR "blob.core.windows.net"`, url: `https://www.google.com/search?q=site:${e}+%22cloudfront.net%22` },
        { category: "Error Pages", query: `site:${seed} "PHP Error" OR "Fatal error" OR "MySQL Error"`, url: `https://www.google.com/search?q=site:${e}+%22PHP+Error%22` },
        { category: "Error Pages", query: `site:${seed} "Internal Server Error" OR "Stack Trace" OR "Debug Mode"`, url: `https://www.google.com/search?q=site:${e}+%22Internal+Server+Error%22` },
        { category: "Cloud/CI", query: `site:${seed} ".travis.yml" OR ".github/workflows" OR ".gitlab-ci.yml"`, url: `https://www.google.com/search?q=site:${e}+%22.travis.yml%22` },
        { category: "Cloud/CI", query: `site:${seed} "docker-compose.yml" OR "Dockerfile" OR ".dockerignore"`, url: `https://www.google.com/search?q=site:${e}+%22docker-compose.yml%22` },
        { category: "Cloud/CI", query: `site:${seed} "terraform.tfstate" OR "terraform.tfvars" OR ".tfstate"`, url: `https://www.google.com/search?q=site:${e}+%22terraform.tfstate%22` },
        { category: "Jira/Confluence", query: `site:${seed} inurl:/jira OR inurl:/confluence OR inurl:/wiki`, url: `https://www.google.com/search?q=site:${e}+inurl:/jira` },
        { category: "Jira/Confluence", query: `site:${seed} intitle:"Jira" OR intitle:"Confluence" OR intitle:"Wiki"`, url: `https://www.google.com/search?q=site:${e}+intitle:%22Jira%22` },
        { category: "Open Redirects", query: `site:${seed} inurl:redirect OR inurl:redir OR inurl:url= OR inurl:next= OR inurl:return=`, url: `https://www.google.com/search?q=site:${e}+inurl:redirect+OR+inurl:url%3D` },
        { category: "Auth Endpoints", query: `site:${seed} inurl:oauth OR inurl:sso OR inurl:saml OR inurl:openid`, url: `https://www.google.com/search?q=site:${e}+inurl:oauth+OR+inurl:saml` },
        { category: "Backups", query: `site:${seed} ext:bak OR ext:old OR ext:backup OR ext:tmp OR ext:swp`, url: `https://www.google.com/search?q=site:${e}+ext:bak+OR+ext:old+OR+ext:backup` },
        { category: "Backups", query: `site:${seed} ext:zip OR ext:tar OR ext:gz OR ext:7z OR ext:rar`, url: `https://www.google.com/search?q=site:${e}+ext:zip+OR+ext:tar+OR+ext:7z` },
        { category: "Source Maps", query: `site:${seed} ext:map OR inurl:.map OR "sourceMappingURL"`, url: `https://www.google.com/search?q=site:${e}+ext:map+OR+%22sourceMappingURL%22` },
        { category: "Env/Secrets", query: `site:${seed} ".env" OR "/.env" OR "/.envrc"`, url: `https://www.google.com/search?q=site:${e}+%22.env%22+OR+%22%2F.envrc%22` },
        { category: "Env/Secrets", query: `site:${seed} "DB_PASSWORD" OR "MAIL_PASSWORD" OR "STRIPE_SECRET" OR "SLACK_TOKEN"`, url: `https://www.google.com/search?q=site:${e}+%22DB_PASSWORD%22+OR+%22STRIPE_SECRET%22` },
        { category: "Email Mentions", query: `site:${seed} "@${seed}"`, url: `https://www.google.com/search?q=site:${e}+%22%40${e}%22` },
        { category: "Email Mentions", query: `"@${seed}" -site:${seed}`, url: `https://www.google.com/search?q=%22%40${e}%22+-site:${e}` },
        { category: "Subdomains (Bing)", query: `site:${seed} -site:www.${seed}`, url: `https://www.bing.com/search?q=site:${e}+-site:www.${e}` },
        { category: "Subdomains (crt.sh)", query: `%.${seed}`, url: `https://crt.sh/?q=%25.${e}` },
        { category: "Hosting Footprints", query: `"${seed}" site:builtwith.com OR site:wappalyzer.com OR site:netcraft.com`, url: `https://www.google.com/search?q=%22${e}%22+site:builtwith.com+OR+site:netcraft.com` },
        { category: "Cert Transparency", query: `"${seed}" site:censys.io OR site:crt.sh OR site:certspotter.com`, url: `https://www.google.com/search?q=%22${e}%22+site:censys.io+OR+site:crt.sh` },
        { category: "Bug Bounty", query: `"${seed}" site:hackerone.com OR site:bugcrowd.com OR site:intigriti.com OR site:huntr.dev`, url: `https://www.google.com/search?q=%22${e}%22+site:hackerone.com+OR+site:bugcrowd.com` },
        { category: "Phishing/Brand Abuse", query: `inurl:${seed.replace(/\./g, "-")} -site:${seed}`, url: `https://www.google.com/search?q=inurl:${encodeURIComponent(seed.replace(/\./g, "-"))}+-site:${e}` },
        { category: "Phishing/Brand Abuse", query: `"${seed}" site:phishtank.org OR site:openphish.com OR site:urlscan.io`, url: `https://www.google.com/search?q=%22${e}%22+site:phishtank.org+OR+site:openphish.com` },
        { category: "Alt Search Engines", query: `site:${seed}`, url: `https://www.bing.com/search?q=site:${e}` },
        { category: "Alt Search Engines", query: `site:${seed}`, url: `https://duckduckgo.com/?q=site:${e}` },
        { category: "Alt Search Engines", query: `site:${seed}`, url: `https://yandex.com/search/?text=site%3A${e}` },
      ],
      ip: [
        { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
        { category: "Shodan/Censys", query: `"${seed}" site:shodan.io OR site:censys.io`, url: `https://www.google.com/search?q=%22${e}%22+site:shodan.io` },
        { category: "Shodan/Censys", query: `"${seed}" site:spyse.com OR site:zoomeye.org OR site:fofa.info`, url: `https://www.google.com/search?q=%22${e}%22+site:spyse.com` },
        { category: "Threat Intel", query: `"${seed}" site:virustotal.com OR site:abuseipdb.com OR site:ipvoid.com`, url: `https://www.google.com/search?q=%22${e}%22+site:virustotal.com` },
        { category: "Threat Intel", query: `"${seed}" site:greynoise.io OR site:threatminer.org OR site:otx.alienvault.com`, url: `https://www.google.com/search?q=%22${e}%22+site:greynoise.io` },
        { category: "Threat Intel", query: `"${seed}" site:ibm.com/security OR site:cisco.com OR site:fireeye.com`, url: `https://www.google.com/search?q=%22${e}%22+site:ibm.com/security` },
        { category: "ASN/BGP", query: `"${seed}" site:ipinfo.io OR site:ip-api.com OR site:ipstack.com`, url: `https://www.google.com/search?q=%22${e}%22+site:ipinfo.io` },
        { category: "ASN/BGP", query: `"${seed}" site:asnlookup.com OR site:bgp.he.net OR site:peeringdb.com`, url: `https://www.google.com/search?q=%22${e}%22+site:bgp.he.net` },
        { category: "Hosting/VPS", query: `"${seed}" site:digitalocean.com OR site:aws.amazon.com OR site:linode.com`, url: `https://www.google.com/search?q=%22${e}%22+site:digitalocean.com` },
        { category: "Hosting/VPS", query: `"${seed}" site:ovh.com OR site:hetzner.com OR site:vultr.com`, url: `https://www.google.com/search?q=%22${e}%22+site:ovh.com` },
        { category: "Pastes/Leaks", query: `"${seed}" site:pastebin.com OR site:rentry.co OR site:controlc.com`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com` },
        { category: "Pastes/Leaks", query: `"${seed}" filetype:log OR filetype:txt "ssh" OR "rdp" OR "vpn"`, url: `https://www.google.com/search?q=%22${e}%22+filetype:log+%22ssh%22` },
        { category: "URLScan", query: `"${seed}" site:urlscan.io OR site:screenshot.guru OR site:archive.org`, url: `https://www.google.com/search?q=%22${e}%22+site:urlscan.io` },
        { category: "Domains on IP", query: `"${seed}" "reverse ip" OR "shared hosting" OR "domains on"`, url: `https://www.google.com/search?q=%22${e}%22+%22reverse+ip%22` },
        { category: "Caches", query: `"${seed}" site:web.archive.org OR site:archive.is`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
        { category: "Forums", query: `"${seed}" site:hackforums.net OR site:breachforums.is OR site:nulled.to`, url: `https://www.google.com/search?q=%22${e}%22+site:hackforums.net` },
        { category: "Social", query: `"${seed}" site:reddit.com OR site:twitter.com OR site:4chan.org`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com` },
        { category: "OSINT DBs", query: `"${seed}" site:oathnet.org OR site:osintnova.com OR site:osint.org`, url: `https://www.google.com/search?q=%22${e}%22+site:oathnet.org` },
        { category: "OSINT DBs", query: `"${seed}" site:osintcurious.io OR site:osintframework.com OR site:osintcombine.com`, url: `https://www.google.com/search?q=%22${e}%22+site:osintcurious.io` },
        { category: "Cert Transparency", query: `"${seed}" site:crt.sh OR site:censys.io OR site:certspotter.com`, url: `https://www.google.com/search?q=%22${e}%22+site:crt.sh+OR+site:censys.io` },
        { category: "Mail/SPF", query: `"${seed}" "spf" OR "include:" OR "v=spf1" OR "dmarc"`, url: `https://www.google.com/search?q=%22${e}%22+%22v%3Dspf1%22+OR+%22dmarc%22` },
        { category: "Honeypot/Scanner Lists", query: `"${seed}" site:honeynet.org OR site:dshield.org OR site:isc.sans.edu`, url: `https://www.google.com/search?q=%22${e}%22+site:dshield.org+OR+site:isc.sans.edu` },
        { category: "Blocklists", query: `"${seed}" site:spamhaus.org OR site:abuse.ch OR site:emergingthreats.net OR site:badips.com`, url: `https://www.google.com/search?q=%22${e}%22+site:spamhaus.org+OR+site:abuse.ch` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
      ],
      hash: [
        { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
        { category: "Malware/Threat Intel", query: `"${seed}" site:virustotal.com OR site:hybrid-analysis.com OR site:any.run`, url: `https://www.google.com/search?q=%22${e}%22+site:virustotal.com+OR+site:hybrid-analysis.com` },
        { category: "Malware/Threat Intel", query: `"${seed}" site:malwarebazaar.abuse.ch OR site:malshare.com OR site:vx-underground.org`, url: `https://www.google.com/search?q=%22${e}%22+site:malwarebazaar.abuse.ch+OR+site:vx-underground.org` },
        { category: "Sandbox/Reports", query: `"${seed}" site:tria.ge OR site:joesandbox.com OR site:cuckoosandbox.org`, url: `https://www.google.com/search?q=%22${e}%22+site:tria.ge+OR+site:joesandbox.com` },
        { category: "Threat Reports", query: `"${seed}" site:otx.alienvault.com OR site:threatminer.org OR site:threatcrowd.org`, url: `https://www.google.com/search?q=%22${e}%22+site:otx.alienvault.com+OR+site:threatminer.org` },
        { category: "GitHub IOCs", query: `"${seed}" site:github.com OR site:gist.github.com`, url: `https://www.google.com/search?q=%22${e}%22+site:github.com+OR+site:gist.github.com` },
        { category: "Password Cracking", query: `"${seed}" site:hashes.com OR site:crackstation.net OR site:hashkiller.io`, url: `https://www.google.com/search?q=%22${e}%22+site:hashes.com+OR+site:crackstation.net` },
        { category: "Pastes", query: `"${seed}" site:pastebin.com OR site:ghostbin.co OR site:rentry.co`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com+OR+site:rentry.co` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
      ],
      crypto_wallet: [
        { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
        { category: "Block Explorers", query: `"${seed}" site:etherscan.io OR site:blockchain.com OR site:blockchair.com`, url: `https://www.google.com/search?q=%22${e}%22+site:etherscan.io+OR+site:blockchain.com` },
        { category: "Block Explorers", query: `"${seed}" site:bscscan.com OR site:polygonscan.com OR site:arbiscan.io OR site:snowtrace.io`, url: `https://www.google.com/search?q=%22${e}%22+site:bscscan.com+OR+site:polygonscan.com` },
        { category: "Block Explorers", query: `"${seed}" site:solscan.io OR site:explorer.solana.com OR site:tronscan.org`, url: `https://www.google.com/search?q=%22${e}%22+site:solscan.io+OR+site:tronscan.org` },
        { category: "Web3 Profiles", query: `"${seed}" site:opensea.io OR site:rarible.com OR site:zapper.xyz OR site:debank.com`, url: `https://www.google.com/search?q=%22${e}%22+site:opensea.io+OR+site:debank.com` },
        { category: "Web3 Profiles", query: `"${seed}" site:warpcast.com OR site:lens.xyz OR site:farcaster.xyz OR site:mirror.xyz`, url: `https://www.google.com/search?q=%22${e}%22+site:warpcast.com+OR+site:mirror.xyz` },
        { category: "ENS / Reverse Resolve", query: `"${seed}" site:app.ens.domains OR ".eth" OR ".lens" OR ".sol"`, url: `https://www.google.com/search?q=%22${e}%22+site:app.ens.domains+OR+%22.eth%22` },
        { category: "Scam DBs", query: `"${seed}" site:cryptoscamdb.org OR site:chainabuse.com OR site:scam-alert.io`, url: `https://www.google.com/search?q=%22${e}%22+site:cryptoscamdb.org+OR+site:chainabuse.com` },
        { category: "Forums/Chatter", query: `"${seed}" site:reddit.com OR site:bitcointalk.org OR site:cryptopanic.com`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com+OR+site:bitcointalk.org` },
        { category: "Telegram/Discord", query: `"${seed}" site:t.me OR site:discord.com OR site:discord.gg`, url: `https://www.google.com/search?q=%22${e}%22+site:t.me+OR+site:discord.gg` },
        { category: "GitHub", query: `"${seed}" site:github.com OR site:gist.github.com`, url: `https://www.google.com/search?q=%22${e}%22+site:github.com+OR+site:gist.github.com` },
        { category: "Pastes", query: `"${seed}" site:pastebin.com OR site:rentry.co OR site:ghostbin.co`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com+OR+site:rentry.co` },
        { category: "Stealer/Wallets.txt", query: `"${seed}" "wallets.txt" OR "metamask" OR "seed phrase"`, url: `https://www.google.com/search?q=%22${e}%22+%22wallets.txt%22+OR+%22metamask%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
        { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
      ],
    };
    return { seed, kind, dorks: map[kind] ?? [] };
  },
}),

export const dork_harvest = tool({
  description:
    "Execute the highest-yield document/leak dorks for a seed and AUTO-RECORD any PDFs, Office docs, CSV/SQL/log/env dumps, pastebin entries, and stealer-log URLs as artifacts (kind='document' for files, kind='leak_paste' for pastes). This is the way to turn google_dorks output into real evidence. Runs N targeted queries through MiniMax web_search, parses URLs from results, classifies them by extension/host, and inserts them directly into the case. Costs 1 MiniMax call per query.",
  inputSchema: z.object({
    seed: z.string(),
    kind: z.enum(["email", "username", "phone", "name", "domain", "ip", "hash", "crypto_wallet"]),
    max_queries: z.number().int().min(1).max(10).default(5),
  }),
  execute: async ({ seed, kind, max_queries }) => {
    // Targeted dork queries per kind, ordered by document/leak yield.
    const QUERIES: Record<string, string[]> = {
      email: [
        `"${seed}" (filetype:pdf OR filetype:doc OR filetype:docx OR filetype:xls OR filetype:xlsx OR filetype:csv)`,
        `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co OR site:justpaste.it OR site:controlc.com OR site:0bin.net)`,
        `"${seed}" ("passwords.txt" OR "credentials.txt" OR "logins.txt" OR "combolist" OR "stealer log")`,
        `"${seed}" (intitle:"index of" OR "directory listing") ("email" OR "users" OR "accounts")`,
        `"${seed}" ("resume" OR "cv" OR "curriculum vitae") (filetype:pdf OR filetype:doc)`,
        `"${seed}" (ext:sql OR ext:db OR ext:bak OR ext:log OR ext:env OR ext:json)`,
      ],
      username: [
        `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co OR site:justpaste.it OR site:0bin.net)`,
        `"${seed}" ("passwords" OR "logins" OR "autofill" OR "wallets.txt") (filetype:txt OR filetype:log)`,
        `"${seed}" (filetype:pdf OR filetype:doc OR filetype:docx)`,
        `"@${seed}" (filetype:pdf OR filetype:csv OR filetype:xlsx)`,
        `"${seed}" ("stealer log" OR "redline" OR "raccoon" OR "vidar" OR "lumma")`,
        `"${seed}" ("combo" OR "combolist" OR "leak" OR "dump")`,
      ],
      phone: [
        `"${seed}" (filetype:pdf OR filetype:csv OR filetype:xls OR filetype:txt)`,
        `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co OR site:justpaste.it)`,
        `"${seed}" ("contact" OR "phone" OR "directory") (filetype:pdf OR filetype:csv)`,
        `"${seed}" ("resume" OR "cv") filetype:pdf`,
        `"${seed}" (intitle:"index of" "contacts" OR "phones")`,
      ],
      name: [
        `"${seed}" (filetype:pdf OR filetype:doc OR filetype:docx)`,
        `"${seed}" ("resume" OR "cv" OR "curriculum vitae") filetype:pdf`,
        `"${seed}" ("deed" OR "property record" OR "court" OR "lawsuit") (filetype:pdf OR filetype:html)`,
        `"${seed}" (site:fec.gov OR site:opensecrets.org) filetype:pdf OR filetype:csv`,
        `"${seed}" ("biography" OR "about" OR "portfolio") filetype:pdf`,
      ],
      domain: [
        `site:${seed} (ext:env OR ext:log OR ext:bak OR ext:sql OR ext:dump OR ext:backup)`,
        `site:${seed} (ext:json OR ext:xml OR ext:yaml OR ext:yml OR ext:config OR ext:map)`,
        `site:${seed} intitle:"index of"`,
        `site:${seed} (filetype:pdf OR filetype:doc OR filetype:docx OR filetype:xls OR filetype:csv)`,
        `site:${seed} ("confidential" OR "internal use only" OR "proprietary") filetype:pdf`,
        `site:${seed} (ext:zip OR ext:tar OR ext:gz OR ext:7z OR ext:rar)`,
      ],
      ip: [
        `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co)`,
        `"${seed}" (filetype:log OR filetype:txt) ("ssh" OR "rdp" OR "vpn" OR "access")`,
        `"${seed}" (filetype:pcap OR filetype:csv OR filetype:json)`,
      ],
      hash: [
        `"${seed}" (site:virustotal.com OR site:hybrid-analysis.com OR site:any.run OR site:tria.ge OR site:joesandbox.com)`,
        `"${seed}" (site:malwarebazaar.abuse.ch OR site:malshare.com OR site:vx-underground.org)`,
        `"${seed}" (site:otx.alienvault.com OR site:threatminer.org OR site:github.com)`,
        `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co)`,
        `"${seed}" (filetype:pdf OR filetype:csv) ("IOC" OR "indicator" OR "report")`,
      ],
      crypto_wallet: [
        `"${seed}" (site:etherscan.io OR site:bscscan.com OR site:polygonscan.com OR site:solscan.io OR site:tronscan.org)`,
        `"${seed}" (site:cryptoscamdb.org OR site:chainabuse.com OR site:scam-alert.io)`,
        `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co)`,
        `"${seed}" ("wallets.txt" OR "metamask" OR "seed phrase" OR "private key")`,
        `"${seed}" (filetype:csv OR filetype:json OR filetype:txt)`,
        `"${seed}" (site:github.com OR site:gist.github.com)`,
      ],
    };

    const queries = (QUERIES[kind] ?? []).slice(0, max_queries);
    if (queries.length === 0) return { ok: false, error: `no dork_harvest queries for kind=${kind}` };

    const DOC_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?|csv|txt|log|sql|bak|env|json|xml|ya?ml|zip|tar|gz|7z|rar|pcap|map|dump|sqlite|db)(?:[?#]|$)/i;
    const PASTE_HOST_RE = /(?:^|\/\/|\.)(pastebin\.com|rentry\.co|ghostbin\.co|justpaste\.it|controlc\.com|0bin\.net|hastebin\.com|paste\.ee|bpaste\.net|termbin\.com|dpaste\.com|paste\.ubuntu\.com|privatebin\.info|gist\.github\.com)\b/i;
    const URL_RE = /https?:\/\/[^\s)\]'"<>]+/g;

    const collected: Array<{ url: string; via: string; classify: "document" | "leak_paste" }> = [];
    const seen = new Set<string>();
    const queryResults: Array<{
      query: string;
      ok: boolean;
      hits: number;
      provider?: "minimax_web_search" | "exa_search";
      status?: number;
      answer?: string;
      error?: string;
    }> = [];

    const extractUrls = (text: string): string[] =>
      Array.from(new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[).,;:]+$/, ""))));

    const exaSearchUrls = async (q: string): Promise<{ ok: boolean; status: number; urls: string[]; note?: string }> => {
      if (!EXA_API_KEY) return { ok: false, status: 0, urls: [], note: "EXA_API_KEY not configured" };
      try {
        const r = await fetchRetry("https://api.exa.ai/search", {
          method: "POST",
          headers: {
            "x-api-key": EXA_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: q, type: "keyword", numResults: 10, contents: false }),
        });
        const data = await r.json().catch(() => ({}));
        const urls = Array.isArray((data as any)?.results)
          ? (data as any).results
              .map((x: any) => (typeof x?.url === "string" ? x.url : ""))
              .filter((u: string) => !!u)
          : [];
        return { ok: r.ok, status: r.status, urls };
      } catch (e) {
        return { ok: false, status: 0, urls: [], note: String(e) };
      }
    };

    for (const q of queries) {
      try {
        const r = await minimaxChat({
          system:
            "You are an OSINT dork-harvester. Use the web_search tool. Run the user's query VERBATIM. Return ONLY a bullet list of every result URL you find (one URL per line, no commentary). Do not summarize. Do not editorialize. If nothing is found, reply with exactly: NONE.",
          user: q,
          webSearch: true,
          maxTokens: 1200,
        });

        let provider: "minimax_web_search" | "exa_search" = "minimax_web_search";
        let status = r.status;
        let text = r.content ?? "";
        let urls = extractUrls(text);
        let providerError: string | undefined;

        // MiniMax web_search occasionally returns upstream 5xx/timeout responses.
        // Treat those as provider degradation, then fall back to Exa so
        // Google Dorking remains available instead of surfacing as offline.
        if (!r.ok || urls.length === 0) {
          const exa = await exaSearchUrls(q);
          if (exa.ok && exa.urls.length > 0) {
            provider = "exa_search";
            status = exa.status;
            urls = exa.urls;
            text = `EXA_FALLBACK:${exa.urls.slice(0, 20).join("\n")}`;
          } else {
            providerError = !r.ok
              ? `minimax_web_search HTTP ${r.status}`
              : (exa.note ? `fallback exa failed: ${exa.note}` : "no URLs returned by minimax or exa");
          }
        }

        let hits = 0;
        for (const u of urls) {
          if (seen.has(u)) continue;
          let classify: "document" | "leak_paste" | null = null;
          if (PASTE_HOST_RE.test(u)) classify = "leak_paste";
          else if (DOC_EXT_RE.test(u)) classify = "document";
          if (!classify) continue;
          seen.add(u);
          collected.push({ url: u, via: q, classify });
          hits++;
        }

        queryResults.push({
          query: q,
          ok: hits > 0,
          provider,
          status,
          hits,
          answer: text.slice(0, 400),
          ...(providerError ? { error: providerError } : {}),
        });
      } catch (e) {
        queryResults.push({ query: q, ok: false, hits: 0, error: String(e) });
      }
    }

    let inserted = 0;
    const providerStats = queryResults.reduce(
      (acc, q) => {
        const p = q.provider ?? "minimax_web_search";
        if (p === "exa_search") acc.exa++;
        else acc.minimax++;
        if (q.ok) acc.success++;
        else acc.failed++;
        return acc;
      },
      { minimax: 0, exa: 0, success: 0, failed: 0 },
    );
    if (collected.length > 0) {
      const rows = collected.map((c) => ({
        thread_id: threadId,
        user_id: userId,
        kind: c.classify,
        value: c.url,
        confidence: c.classify === "leak_paste" ? 55 : 60,
        source: "dork_harvest",
        metadata: {
          seed,
          seed_kind: kind,
          dork_query: c.via,
          discovered_via: "google_dork → minimax web_search",
        },
      }));
      const safeRows = scrubArtifactRows(rows);
      const { error } = await supabase.from("artifacts").insert(safeRows);
      if (!error) {
        inserted = safeRows.length;
        bumpArtifacts(safeRows.length, safeRows.map((r) => String(r.kind)));
      } else {
        return { ok: false, error: error.message, queries: queryResults, found: collected.length, inserted: 0 };
      }
    }

    return {
      ok: true,
      seed,
      kind,
      queries_run: queryResults.length,
      urls_found: collected.length,
      artifacts_inserted: inserted,
      sample: collected.slice(0, 20),
      per_query: queryResults,
      provider_stats: providerStats,
      degraded: providerStats.exa > 0,
      note: inserted > 0
        ? `Inserted ${inserted} document/leak artifacts. They are now in the case — do NOT also record them via record_artifacts.${providerStats.exa > 0 ? ` Fallback engaged: Exa handled ${providerStats.exa}/${queryResults.length} query(ies).` : ""}`
        : `No document/leak URLs found in this harvest pass.${providerStats.exa > 0 ? ` Fallback engaged: Exa handled ${providerStats.exa}/${queryResults.length} query(ies).` : ""}`,
    };
  },
}),

export const gemini_deep_dork = tool({
  description:
    "DEEP DORK via Gemini 2.5 Flash with native Google Search grounding. Gemini reasons about the seed, formulates several targeted Google dork queries internally, executes them against real Google, and returns a synthesized writeup PLUS all source URLs as grounding citations. Use this when google_dorks/dork_harvest miss something or you want LLM-driven dork generation (e.g. tricky person/handle disambiguation, leak/breach context, niche forum surfacing). AUTO-RECORDS every cited URL as an artifact (kind='url' or classified by extension as 'document'/'leak_paste'). 1 Gemini call ≈ $0.002.",
  inputSchema: z.object({
    seed: z.string(),
    kind: z.enum(["email","username","phone","name","person","domain","ip","hash","crypto_wallet","url","other"]),
    focus: z.string().optional().describe("Optional angle, e.g. 'breach exposure', 'resume/CV leaks', 'social handles', 'pastebin dumps', 'forum posts', 'court records'."),
  }),
  execute: async ({ seed, kind, focus }) => {
    if (!GEMINI_API_KEY) return { ok: false, error: "GEMINI_API_KEY not configured" };
    const system =
      "You are an elite OSINT dork operator. For the given seed, design 5-8 high-yield Google dork queries (use site:, filetype:, intitle:, inurl:, exact-phrase quoting, boolean OR groups). EXECUTE them with the google_search tool. Then write a concise bulletized intelligence summary citing ONLY what your searches actually found. Be specific: name the platforms/leak sites/forums/document types you surfaced and quote any usernames, emails, phone fragments, or filenames discovered. If nothing material is found, say so plainly. Do not fabricate.";
    const user =
      `Seed (${kind}): ${seed}\n` +
      (focus ? `Focus: ${focus}\n` : "") +
      `Goal: deep-dork this seed across Google. Surface breach/leak exposure, document/file leaks (PDFs, CVs, dumps), pastebin/rentry/ghostbin pastes, forum mentions, social/profile traces, and any public-records or news hits. Prefer recent + high-signal results.`;
    const res = await geminiGroundedSearch({ prompt: user, system });
    if (!res.ok) return { ok: false, status: res.status, error: "gemini_grounded_search_failed", detail: String((res.raw as any)?.error?.message ?? "").slice(0, 400) };

    // Classify + dedupe citations, then auto-record.
    const seen = new Set<string>();
    const classify = (u: string): "document" | "leak_paste" | "url" => {
      const low = u.toLowerCase();
      if (/\.(pdf|docx?|xlsx?|pptx?|csv|sql|db|bak|log|env|json|txt)(\?|$)/.test(low)) return "document";
      if (/(pastebin\.com|rentry\.co|ghostbin\.co|justpaste\.it|controlc\.com|0bin\.net|hastebin\.com|paste\.ee|dpaste\.com)/.test(low)) return "leak_paste";
      return "url";
    };
    const rows = res.citations
      .filter((c) => {
        if (!c.uri || seen.has(c.uri)) return false;
        // Drop ephemeral Gemini grounding-redirect URLs (expire in minutes,
        // zero OSINT value) and raw google search URLs. Massive junk source.
        const low = c.uri.toLowerCase();
        if (low.includes("vertexaisearch.cloud.google.com")) return false;
        if (low.includes("google.com/search?") || low.includes("/url?q=")) return false;
        if (low.startsWith("https://www.google.com/") && !low.includes("/maps/")) return false;
        seen.add(c.uri);
        return true;
      })
      .map((c) => {
        const k = classify(c.uri);
        return {
          thread_id: threadId,
          user_id: userId,
          kind: k,
          value: c.uri,
          confidence: k === "leak_paste" ? 60 : k === "document" ? 65 : 55,
          source: "gemini_deep_dork",
          metadata: {
            seed,
            seed_kind: kind,
            focus: focus ?? null,
            title: c.title ?? null,
            discovered_via: "gemini google_search grounding",
          },
        };
      });
    let inserted = 0;
    if (rows.length) {
      const safeRows = scrubArtifactRows(rows);
      const { error } = await supabase.from("artifacts").insert(safeRows);
      if (!error) {
        inserted = safeRows.length;
        bumpArtifacts(safeRows.length, safeRows.map((r) => String(r.kind)));
      }
    }
    return {
      ok: true,
      seed,
      kind,
      focus: focus ?? null,
      summary: res.text.slice(0, 6000),
      dork_queries: res.queries,
      citations: res.citations.slice(0, 40),
      artifacts_inserted: inserted,
      note: inserted > 0
        ? `Recorded ${inserted} cited URLs as artifacts — do NOT re-record via record_artifacts.`
        : "No grounded citations returned.",
    };
  },
}),

export const exa_search = tool({
  description:
    "Exa /search — neural + keyword web search with optional inline contents (text, highlights, summary). PRIMARY web search alongside minimax_web_search — call BOTH in parallel on any meaningful query. Exa's neural mode is best for semantic / concept queries ('people who wrote about X', 'companies similar to Y'); keyword mode is best for exact strings (emails, usernames, hashes, wallets). Supports includeDomains/excludeDomains, startPublishedDate/endPublishedDate, and category ('company','research paper','news','pdf','github','tweet','personal site','linkedin profile','financial report').",
  inputSchema: z.object({
    query: z.string().min(2),
    type: z.enum(["auto", "neural", "keyword"]).default("auto"),
    numResults: z.number().int().min(1).max(25).default(10),
    includeDomains: z.array(z.string()).optional(),
    excludeDomains: z.array(z.string()).optional(),
    startPublishedDate: z.string().optional().describe("ISO date, e.g. 2024-01-01"),
    endPublishedDate: z.string().optional(),
    category: z.enum([
      "company","research paper","news","pdf","github","tweet",
      "personal site","linkedin profile","financial report",
    ]).optional(),
    contents: z.boolean().default(true).describe("If true, include text+highlights+summary for each result."),
  }),
  execute: async ({ query, type, numResults, includeDomains, excludeDomains, startPublishedDate, endPublishedDate, category, contents }) => {
    if (!EXA_API_KEY) return { error: "EXA_API_KEY not configured" };
    try {
      const body: Record<string, unknown> = { query, type, numResults };
      if (includeDomains?.length) body.includeDomains = includeDomains;
      if (excludeDomains?.length) body.excludeDomains = excludeDomains;
      if (startPublishedDate) body.startPublishedDate = startPublishedDate;
      if (endPublishedDate) body.endPublishedDate = endPublishedDate;
      if (category) body.category = category;
      if (contents) body.contents = { text: { maxCharacters: 2000 }, highlights: true, summary: true };
      const r = await fetchRetry("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "x-api-key": EXA_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: trimExaResults(data) };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const exa_find_similar = tool({
  description:
    "Exa /findSimilar — given a known URL, find pages similar to it (same person's other profiles, related company sites, similar leak listings). Powerful for OSINT pivoting from any single confirmed profile URL.",
  inputSchema: z.object({
    url: z.string().url(),
    numResults: z.number().int().min(1).max(25).default(10),
    excludeSourceDomain: z.boolean().default(true),
    contents: z.boolean().default(true),
  }),
  execute: async ({ url, numResults, excludeSourceDomain, contents }) => {
    if (!EXA_API_KEY) return { error: "EXA_API_KEY not configured" };
    try {
      const body: Record<string, unknown> = { url, numResults, excludeSourceDomain };
      if (contents) body.contents = { text: { maxCharacters: 1500 }, highlights: true };
      const r = await fetchRetry("https://api.exa.ai/findSimilar", {
        method: "POST",
        headers: {
          "x-api-key": EXA_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: trimExaResults(data) };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const exa_get_contents = tool({
  description:
    "Exa /contents — fetch full text, highlights, and an AI summary for up to 10 URLs in a single call. Best for bulk URL reading when you already have URLs from search results and just need their content. Set livecrawl='always' to bypass Exa's cache for time-sensitive pages.",
  inputSchema: z.object({
    urls: z.array(z.string().url()).min(1).max(10),
    text: z.boolean().default(true),
    highlights: z.boolean().default(true),
    summary: z.boolean().default(true),
    livecrawl: z.enum(["never","fallback","auto","always"]).default("auto"),
    maxCharacters: z.number().int().min(200).max(8000).default(3000),
  }),
  execute: async ({ urls, text, highlights, summary, livecrawl, maxCharacters }) => {
    if (!EXA_API_KEY) return { error: "EXA_API_KEY not configured" };
    try {
      const body: Record<string, unknown> = { urls, livecrawl };
      if (text) body.text = { maxCharacters };
      if (highlights) body.highlights = true;
      if (summary) body.summary = true;
      const r = await fetchRetry("https://api.exa.ai/contents", {
        method: "POST",
        headers: {
          "x-api-key": EXA_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: trimExaResults(data) };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const jina_reader_scrape = tool({
  description:
    "#1 PRIMARY scraper for ANY URL — free, unlimited, returns clean LLM-ready markdown. Always prefer this over firecrawl/exa_contents for single-page extraction. Use https://r.jina.ai/{url} under the hood. Works on articles, profile pages, forums, leak listings, dorks hits, Discord/Telegram links, PDFs (best-effort), etc. Pass a fully-qualified http(s) URL — do NOT pass relative paths or text snippets.",
  inputSchema: z.object({
    url: z.string().url(),
    maxChars: z.number().int().min(500).max(40000).default(18000),
  }),
  execute: async ({ url, maxChars }) => {
    // Preflight: trim whitespace, drop fragment, drop non-http(s),
    // reject relative paths, snippets, and IDN/odd schemes that 422 on Jina.
    const raw = (url ?? "").trim();
    if (!raw) return { error: "empty_url", skipped: true };
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return { error: "invalid_url", skipped: true, url: raw }; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "non_http_url", skipped: true, url: raw };
    }
    parsed.hash = ""; // r.jina.ai 422s on fragments
    // Rebuild a clean URL; r.jina.ai expects the raw URL appended.
    const clean = parsed.toString();
    try {
      const headers: Record<string, string> = { Accept: "text/plain" };
      if (JINA_API_KEY) headers.Authorization = `Bearer ${JINA_API_KEY}`;
      const target = `https://r.jina.ai/${clean}`;
      const r = await fetchRetry(target, { headers }, { retries: 2 });
      if (!r.ok) {
        // 422 = unprocessable URL (paywall, JS app, binary, login wall, etc.)
        // 451/403 = blocked by origin. Do NOT retry — signal the agent to pivot.
        const hint = r.status === 422
          ? "jina cannot parse this URL — try a different source or wayback snapshot"
          : r.status === 451 || r.status === 403
            ? "origin blocked — try wayback_snapshots or a different result"
            : undefined;
        return { error: `jina ${r.status}`, status: r.status, url: clean, hint };
      }
      const text = await r.text();
      return { ok: true, url: clean, markdown: text.slice(0, maxChars), truncated: text.length > maxChars };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const minimax_web_search = tool({
  description:
    "Live web search powered by Perplexity Sonar (grounded, real-time, with citations). Use early on the seed and on every new email/handle/name/domain/phone you discover. Returns a concise synthesized answer plus the list of cited source URLs.",
  inputSchema: z.object({
    query: z.string().min(2).describe("Search query, e.g. \"alice@example.com\" leak OR breach"),
    focus: z.string().optional().describe("Optional steering hint, e.g. 'find social profiles', 'find leaks'"),
  }),
  execute: async ({ query, focus }) => {
    const gated = gateStage2("minimax_web_search");
    if (gated) return gated;
    if (!PERPLEXITY_API_KEY) return { error: "PERPLEXITY_API_KEY not configured" };
    try {
      const r = await fetchRetry("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [
            {
              role: "system",
              content:
                "You are an OSINT web-search worker. Return a concise factual answer in bullet points. Do not speculate. Prefer specific names, dates, URLs, and identifiers. If nothing relevant is found, say so explicitly.",
            },
            {
              role: "user",
              content: `${focus ? `Focus: ${focus}\n\n` : ""}Query: ${query}`,
            },
          ],
          max_tokens: 1200,
        }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.warn(`[minimax_web_search] perplexity ${r.status} for query="${query.slice(0,120)}": ${body.slice(0, 300)}`);
        return { ok: false, status: r.status, error: `perplexity ${r.status}: ${body.slice(0, 300)}`, answer: "", citations: [] };
      }
      const data = await r.json() as {
        choices?: { message?: { content?: string } }[];
        citations?: string[];
        search_results?: { url?: string; title?: string }[];
      };
      const answer = (data.choices?.[0]?.message?.content ?? "").trim();
      const citations = (data.citations ?? data.search_results?.map((s) => s.url ?? "").filter(Boolean) ?? [])
        .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
        .slice(0, 25);
      const usable = answer.length > 0 || citations.length > 0;
      if (!usable) {
        return { ok: false, status: r.status, error: "perplexity returned empty answer and no citations", answer, citations };
      }
      return { ok: true, status: r.status, answer, citations };
    } catch (e) {
      console.warn(`[minimax_web_search] threw for query="${query.slice(0,120)}":`, e);
      return { ok: false, error: String(e), answer: "", citations: [] };
    }
  },
}),

