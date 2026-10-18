# Behavior Spec: OpenArt (capability: multi-model AI image/video studio)

Source: public third-party descriptions only (shotkit.com review, techbullion review, toolsforhumans.ai, neura.market pricing listing, a Substack walkthrough of Characters). No OpenArt binaries, assets, or private APIs touched. Nobody has run the product hands-on yet. Several sources carry promo/affiliate links, so treat feature claims as unverified until Robbie supplies a screen recording or account walkthrough.

## Triage (belt rule 2)
- **Orchestration layer: remakeable.** Model picker, prompt-to-image/video flow, library, character save/recall, storyboard assembly, credit metering.
- **Generation itself: not remade, swapped.** OpenArt does not own most of its engines. Sources say it aggregates 100+ models from Google, OpenAI, Black Forest Labs, Stability AI, Kling and others. The Kingmaker version would call open models (e.g. Flux/SD class) on local or already-owned hardware.
- **Video generation: likely out of reach locally.** Hardware-bound. Needs Robbie's call on whether to include or drop it.
- Tier numbers from the remake pipeline's prompt not applied: that prompt wasn't available to me, so the pipeline needs to confirm the tier.

## Observed behaviors
1. **Entry:** pick a category (Image, Video, Character, Audio, Story), then a model, then prompt.
2. **Model hub:** one dashboard, many engines; different models cost different credits per output.
3. **Text-to-image / text-to-video / image-to-video**, plus video restyle, effects, character replace, camera control.
4. **Characters:** create from reference images, a text description, or a step-by-step builder. Described inputs: 10-20 reference images for training. Build takes about 10 minutes. Saved to a library, then reused across expressions, poses, outfits, scenes.
5. **Custom model training:** personal style/brand models from reference images.
6. **One-Click Story:** automated storyboard/story video from a prompt.
7. **Audio:** voiceovers and music.
8. **Editing tools:** upscale, filters (80+ reported), clothes changer, text removal; each edit costs extra credits.
9. **Credits economy:** monthly credit allotment per plan, per-model cost, caps on consistent characters, trained models, stories, and parallel generations. Listed Essential ~$14/seat/mo (4,000 credits), Advanced ~$29/seat/mo (12,000). New free signups: 40 one-time credits. Prices are from a third-party listing and may be stale.
10. **Community gallery:** inspiration and learning content.

## Inputs / outputs
In: text prompts, reference images/video, model choice, credit balance. Out: images, clips, audio, saved characters, stories, downloads.

## Not yet observed (needs real run)
Latency, generation quality per model, how character consistency actually performs, UI flow detail.
