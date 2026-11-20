# The Home Assistant add-on: the app's own image (BUILD_FROM, see build.yaml),
# with its data where an add-on keeps it.
ARG BUILD_FROM
FROM ${BUILD_FROM}

# Add-on storage (/data, /media) belongs to root
USER root

# /data is kept across updates and included in backups; the cache (thumbnails,
# the depth model) is left out of backups. Artwork in /media/samsung-emdx
# shows in the app's library.
ENV EMDX_DATA_DIR=/data \
    EMDX_CACHE_DIR=/data/cache \
    EMDX_GALLERY_DIR=/media/samsung-emdx
