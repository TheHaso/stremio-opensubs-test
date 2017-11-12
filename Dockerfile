
# Node 4.4 on Debian Jessie
FROM node:argon

# Meta
MAINTAINER Ivo Georgiev <ivo@strem.io>
LABEL Description="Stremio OpenSubtitles" Vendor="Smart Code ltd" Version="1.16.2"

# Create app directory
RUN mkdir -p /var/www/opensubtitles

# install app dependencies
WORKDIR /var/www/opensubtitles
COPY package.json /var/www/opensubtitles
RUN npm install --silent 
RUN npm install redis

# Bundle app source
WORKDIR /var/www/opensubtitles
COPY . /var/www/opensubtitles

EXPOSE 3011
ENV NODE_ENV production
CMD npm start

