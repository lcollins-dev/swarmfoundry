#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE "swarmfoundry" WITH ENCODING 'UTF8';

  CREATE USER "swarmfoundry" WITH ENCRYPTED PASSWORD 'swarmfoundry';

  GRANT CONNECT ON DATABASE "swarmfoundry" TO "swarmfoundry";
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "swarmfoundry" <<-EOSQL
  GRANT ALL ON SCHEMA public TO "swarmfoundry";
EOSQL