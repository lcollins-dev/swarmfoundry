export TYPEORM_HOST=${TYPEORM_HOST:-localhost}
export TYPEORM_PORT=${TYPEORM_PORT:-5432}
export TYPEORM_USERNAME=${TYPEORM_USERNAME:-swarmfoundry}
export TYPEORM_PASSWORD=${TYPEORM_PASSWORD:-swarmfoundry}
export TYPEORM_DATABASE=${TYPEORM_DATABASE:-swarmfoundry}
export USE_TEST_MIGRATIONS=true

echo "Cleaning out database..."

PGPASSWORD=$TYPEORM_PASSWORD psql \
  --host="$TYPEORM_HOST" \
  --port="$TYPEORM_PORT" \
  --username="$TYPEORM_USERNAME" \
  --dbname="$TYPEORM_DATABASE" \
  --command="
DO \$\$ DECLARE
  r RECORD;
BEGIN
  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = current_schema()) LOOP
    EXECUTE 'DROP TABLE ' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
END \$\$;
"

echo "Running migrations..."

npm run build
npx typeorm migration:run -d dist/cli-data-source.js

echo "Done"
