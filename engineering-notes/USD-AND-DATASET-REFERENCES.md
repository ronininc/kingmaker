# USD and dataset references checked2026-11-15

- NVIDIA PhysicalAI-SimReady-Materials is specifically a USD/MaterialX/OpenPBR material collection. Its official README licenses materials/textures MIT-0, lists1,705 materials in category release archives, and specifies OpenPBR1.1/OpenUSD24.08/MaterialX1.38.10-OpenPBR. The shared base-class file and relative texture package layout must remain available. This is NOT evidence that any USD viewer can render its full shader model or that Kingmaker implements SimReady sensor behavior. https://github.com/NVIDIA-Omniverse/PhysicalAI-SimReady-Materials
- Omniverse sample datasets demonstrate USD organization/composition. They are not universally Apache2 or public domain; inspect each pack and applicable terms. No NVIDIA sample was downloaded. https://docs.omniverse.nvidia.com/usd/latest/usd_content_samples/sample_content.html and https://docs.omniverse.nvidia.com/usd/latest/common/NVIDIA_Omniverse_License_Agreement.html
- Objaverse dataset compilation is ODC-By1.0; individual objects have distinct CC licenses including noncommercial and share-alike variants. The metadata carries per-object license. A dataset-card badge does not clear all objects for commercial redistribution or training. https://huggingface.co/datasets/allenai/objaverse/blob/main/README.md
- Hugging Face is a potential source platform, not a blanket license. Pin the exact dataset/revision/file, inspect its card and file notices, retain access/redistribution/attribution restrictions, and obtain required gate/login/upload approvals. No bulk ingestion is authorized by this reference note.

## Implemented native technique

`usd-lathe` writes new USDA geometry, normals, UVs, units and basic UsdPreviewSurface parameters using original bounded code. It does not import NVIDIA/Objaverse materials. Official format reference: https://openusd.org/release/spec_usdpreviewsurface.html

The generated stage passed local Blender4.2.3 USD import:54vertices,48triangles,one material. Blender emitted existing USD plugin type-registration warnings (sdrGlslfx/hio) but the explicit mesh/material assertions passed. No settings or plugin repair attempted. This is basic import evidence, not renderer parity, complete USD support or SimReady certification.
