CREATE DATABASE "swarmfoundry" WITH ENCODING 'UTF8';

CREATE USER "swarmfoundry" WITH ENCRYPTED PASSWORD 'swarmfoundry';

GRANT CONNECT ON DATABASE "swarmfoundry" TO "swarmfoundry";

-- \c swarmfoundry

GRANT ALL ON SCHEMA public TO "swarmfoundry";
