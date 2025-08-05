import React, { useEffect, useState } from 'react';
import { ChartProps } from '../../chart/Chart';
import { MapContainer, TileLayer, GeoJSON, Popup, Marker } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { extensionEnabled } from '../../utils/ReportUtils';
import { useStyleRules } from '../../extensions/styling/StyleRuleEvaluator';

// Fix for default markers in React Leaflet
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: require('leaflet/dist/images/marker-icon-2x.png'),
    iconUrl: require('leaflet/dist/images/marker-icon.png'),
    shadowUrl: require('leaflet/dist/images/marker-shadow.png'),
});

const NeoItineraryMapChart: React.FC<ChartProps> = (props) => {
    const [geoJsonData, setGeoJsonData] = useState(null);
    const [mapCenter, setMapCenter] = useState([41.9028, 12.4964]); // Default center (Mediterranean - Rome)
    const [mapZoom, setMapZoom] = useState(6);
    const [personColors, setPersonColors] = useState({});
    const [selectedPerson, setSelectedPerson] = useState(null);
    const [personWaypoints, setPersonWaypoints] = useState({}); // Store waypoints by person for sequencing
    const [selectedRoute, setSelectedRoute] = useState(null); // Track selected route for showing dates
    const [waypointSequence, setWaypointSequence] = useState({}); // Track waypoint order for each person
    const [renderKey, setRenderKey] = useState(0); // Force re-render when route selection changes

    // Settings from props
    const mapProviderURL = props.settings?.providerUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const attribution = props.settings?.attribution || '&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors';
    const routeWeight = props.settings?.routeWeight || 3;
    const showWaypoints = props.settings?.showWaypoints !== false;
    const showRoutes = props.settings?.showRoutes !== false;

    // Dynamic color generation function - creates unlimited unique colors
    const generateColor = (index) => {
        const hue = (index * 137.508) % 360; // Golden angle for good distribution
        const saturation = 60 + (index % 3) * 15; // Vary saturation: 60%, 75%, 90%
        const lightness = 45 + (index % 2) * 10;  // Vary lightness: 45%, 55%
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    };

    // Safe function to get person color (no setState during render)
    const getPersonColor = (personName) => {
        return personColors[personName] || '#666666'; // Fallback color
    };

    const styleRules = useStyleRules(
        extensionEnabled(props.extensions, 'styling'),
        props.settings.styleRules,
        props.getGlobalParameter
    );

    useEffect(() => {
        if (props.records && props.records.length > 0) {
            processItineraryData();
        }
    }, [props.records]);


    const processItineraryData = () => {
        try {
            const allFeatures = [];
            const validCoordinates = [];
            const uniquePersons = new Set();

            // First pass: collect all unique person names
            props.records.forEach((record) => {
                const keys = record.keys || [];
                const values = record._fields || [];

                keys.forEach((key, index) => {
                    const value = values[index];
                    if (value && value.itinerary && value.itinerary.type === 'FeatureCollection') {
                        const personName = value.name || value.id || 'Unknown Person';
                        uniquePersons.add(personName);
                    } else if (value && value.type === 'FeatureCollection') {
                        let personName = 'Unknown Person';
                        if (record.get) {
                            try { personName = record.get('name') || record.get('id') || personName; } catch(e) {}
                        }
                        if (keys.length > 1) {
                            const nameIndex = keys.findIndex(k => k.includes('name') || k.includes('id'));
                            if (nameIndex >= 0) {
                                personName = values[nameIndex] || personName;
                            }
                        }
                        uniquePersons.add(personName);
                    }
                });
            });

            // Generate colors for all unique persons
            const newPersonColors = {};
            const newPersonWaypoints = {};
            const newWaypointSequence = {};
            Array.from(uniquePersons).forEach((personName, index) => {
                newPersonColors[personName] = generateColor(index);
                newPersonWaypoints[personName] = [];
                newWaypointSequence[personName] = {};
            });
            setPersonColors(newPersonColors);
            setPersonWaypoints(newPersonWaypoints);
            setWaypointSequence(newWaypointSequence);

            props.records.forEach((record, recordIndex) => {
                const keys = record.keys || [];
                const values = record._fields || [];

                // Helper function to process itinerary data
                const processItinerary = (itinerary, personName) => {
                    // First collect all waypoints for this person to determine sequence
                    const waypoints = itinerary.features
                        .filter(f => f.geometry.type === 'Point')
                        .map(f => ({
                            ...f,
                            properties: {
                                ...f.properties,
                                person: personName
                            }
                        }))
                        .sort((a, b) => {
                            // Sort by date if available
                            const dateA = a.properties.date_of_stop || a.properties.date || '';
                            const dateB = b.properties.date_of_stop || b.properties.date || '';
                            return dateA.localeCompare(dateB);
                        });
                    
                    newPersonWaypoints[personName] = waypoints;
                    
                    // Create sequence mapping for this person's waypoints
                    waypoints.forEach((waypoint, index) => {
                        const key = `${waypoint.geometry.coordinates[0]}_${waypoint.geometry.coordinates[1]}`;
                        const sequenceInfo = {
                            index: index,
                            total: waypoints.length,
                            isFirst: index === 0,
                            isLast: index === waypoints.length - 1,
                            waypoint: waypoint
                        };
                        newWaypointSequence[personName][key] = sequenceInfo;
                    });

                    itinerary.features.forEach((feature, featureIndex) => {
                        if (feature.type === 'Feature') {

                            // Add person name to properties for identification
                            feature.properties = {
                                ...feature.properties,
                                person: personName
                            };

                            // For Point features, collect coordinates for map centering
                            if (feature.geometry.type === 'Point') {
                                console.log(`ItineraryMap - Point coordinates:`, feature.geometry.coordinates);
                                if (feature.geometry.coordinates &&
                                    feature.geometry.coordinates[0] !== null &&
                                    feature.geometry.coordinates[1] !== null) {
                                    console.log(`ItineraryMap - Adding valid point coordinates:`, feature.geometry.coordinates);
                                    validCoordinates.push(feature.geometry.coordinates);
                                } else {
                                    console.log(`ItineraryMap - Point coordinates are null or invalid:`, feature.geometry.coordinates);
                                }
                            }

                            // For LineString features, extract valid coordinates
                            if (feature.geometry.type === 'LineString') {
                                console.log(`ItineraryMap - LineString coordinates:`, feature.geometry.coordinates);
                                if (feature.geometry.coordinates && feature.geometry.coordinates.length > 0) {
                                    feature.geometry.coordinates.forEach((coord, coordIndex) => {
                                        console.log(`ItineraryMap - LineString coord ${coordIndex}:`, coord);
                                        if (coord && coord[0] !== null && coord[1] !== null) {
                                            console.log(`ItineraryMap - Adding valid line coordinate:`, coord);
                                            validCoordinates.push(coord);
                                        }
                                    });

                                    // Filter out null coordinates from LineString
                                    feature.geometry.coordinates = feature.geometry.coordinates.filter(
                                        coord => coord && coord[0] !== null && coord[1] !== null
                                    );
                                } else {
                                    console.log(`ItineraryMap - Empty LineString coordinates, skipping feature`);
                                    return; // Skip empty LineString features
                                }
                            }

                            // Only add features that have valid coordinates
                            if ((feature.geometry.type === 'Point' && feature.geometry.coordinates &&
                                    feature.geometry.coordinates[0] !== null && feature.geometry.coordinates[1] !== null) ||
                                (feature.geometry.type === 'LineString' && feature.geometry.coordinates &&
                                    feature.geometry.coordinates.length > 0)) {
                                allFeatures.push(feature);
                                console.log(`ItineraryMap - Added feature to collection:`, feature);
                            } else {
                                console.log(`ItineraryMap - Skipped invalid feature:`, feature);
                            }
                        }
                    });
                };

                keys.forEach((key, index) => {
                    const value = values[index];

                    // Check if this field contains an itinerary with GeoJSON structure
                    if (value && value.itinerary && value.itinerary.type === 'FeatureCollection') {
                        const personName = value.name || value.id || 'Unknown Person';
                        processItinerary(value.itinerary, personName);
                    }
                    // Also check if the value itself is a GeoJSON FeatureCollection (direct query result)
                    else if (value && value.type === 'FeatureCollection') {
                        // Try to get person name from different sources
                        let personName = 'Unknown Person';
                        if (record.get) {
                            try { personName = record.get('name') || record.get('id') || personName; } catch(e) {}
                        }
                        // Also check if there's a name/id in the current field
                        if (keys.length > 1) {
                            const nameIndex = keys.findIndex(k => k.includes('name') || k.includes('id'));
                            if (nameIndex >= 0) {
                                personName = values[nameIndex] || personName;
                            }
                        }
                        processItinerary(value, personName);
                    }
                });
            });

            // Calculate map bounds from valid coordinates
            if (validCoordinates.length > 0) {
                const lats = validCoordinates.map(coord => coord[1]);
                const lngs = validCoordinates.map(coord => coord[0]);

                const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
                const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;

                setMapCenter([centerLat, centerLng]);

                // Calculate zoom level based on coordinate spread
                const latSpread = Math.max(...lats) - Math.min(...lats);
                const lngSpread = Math.max(...lngs) - Math.min(...lngs);
                const maxSpread = Math.max(latSpread, lngSpread);

                let zoom = 10;
                if (maxSpread > 20) zoom = 3;
                else if (maxSpread > 10) zoom = 4;
                else if (maxSpread > 5) zoom = 5;
                else if (maxSpread > 2) zoom = 6;
                else if (maxSpread > 1) zoom = 7;

                setMapZoom(zoom);
            }

            // Create GeoJSON data
            const geoJsonCollection = {
                type: 'FeatureCollection',
                features: allFeatures
            };


            setGeoJsonData(geoJsonCollection);
        } catch (error) {
            console.error('Error processing itinerary data:', error);
        }
    };

    const getFeatureStyle = (feature) => {
        const { geometry, properties } = feature;
        
        // Get person-specific color
        const personName = properties.person || 'Unknown';
        const personColor = getPersonColor(personName);
        
        // Determine if this person is selected or should be faded
        const isSelected = !selectedRoute || selectedRoute === personName;
        const baseOpacity = isSelected ? 1.0 : 0.1;
        
        // Check if this route is selected for date display
        const isRouteSelected = selectedRoute === personName;
        const routeOpacity = isRouteSelected ? 1.0 : (isSelected ? 0.8 : 0.1);

        if (geometry.type === 'LineString' && showRoutes) {
            return {
                color: personColor,
                weight: isRouteSelected ? routeWeight + 2 : routeWeight,
                opacity: routeOpacity
            };
        }

        if (geometry.type === 'Point' && showWaypoints) {
            // Get waypoint sequence info
            const key = `${geometry.coordinates[0]}_${geometry.coordinates[1]}`;
            const sequenceInfo = waypointSequence[personName] && waypointSequence[personName][key];
            
            let radius = 4; // Made smaller
            let fillOpacity = 0.8;
            let weight = 2;
            
            // Only show custom styling when route is selected
            if (selectedRoute === personName && sequenceInfo) {
                if (sequenceInfo.isFirst) {
                    // First waypoint: filled circle (start)
                    fillOpacity = 1.0;
                    radius = 6; // Made smaller
                    weight = 3;
                } else if (sequenceInfo.isLast) {
                    // Last waypoint: filled circle (end)
                    fillOpacity = 1.0;
                    radius = 6; // Made smaller 
                    weight = 3;
                } else {
                    // Middle waypoints: outlined circle only
                    fillOpacity = 0;
                    radius = 4; // Made smaller
                    weight = 2;
                }
            } else {
                // Default circle when route not selected
                fillOpacity = 0.8;
                radius = 4; // Made smaller
                weight = 2;
            }

            return {
                color: personColor,
                fillColor: personColor,
                fillOpacity: fillOpacity * baseOpacity,
                opacity: baseOpacity,
                radius: radius,
                weight: weight
            };
        }

        return {};
    };



    const onEachFeature = (feature, layer) => {
        if (feature.properties && (feature.properties.label || feature.properties.person)) {
            const popupContent = `
        <div>
          <strong>${feature.properties.person || 'Unknown'}</strong><br/>
          ${feature.properties.label ? `<strong>Place:</strong> ${feature.properties.label}<br/>` : ''}
          ${feature.properties.date_of_stop ? `<strong>Date:</strong> ${feature.properties.date_of_stop}<br/>` : ''}
          ${feature.properties.type_of_stop ? `<strong>Type:</strong> ${feature.properties.type_of_stop}` : ''}
        </div>
      `;
            layer.bindPopup(popupContent);
            
            // Add click handler for person selection and route date display
            layer.on('click', (e) => {
                const personName = feature.properties.person || 'Unknown';
                
                // Both route lines AND waypoint dots should show/hide route dates
                if (feature.geometry.type === 'LineString' || feature.geometry.type === 'Point') {
                    // Route or waypoint clicked - toggle date display for this person's waypoints
                    if (selectedRoute === personName) {
                        setSelectedRoute(null);
                    } else {
                        setSelectedRoute(personName);
                    }
                    // Force re-render to clear previous route's custom icons
                    setRenderKey(prev => prev + 1);
                }
                // Stop event propagation to prevent map click
                e.originalEvent.stopPropagation();
            });
        }
    };

    const pointToLayer = (feature, latlng) => {
        if (feature.geometry.type === 'Point') {
            const style = getFeatureStyle(feature);
            const personName = feature.properties.person || 'Unknown';
            const personColor = getPersonColor(personName);
            
            // Get waypoint sequence info
            const key = `${feature.geometry.coordinates[0]}_${feature.geometry.coordinates[1]}`;
            const sequenceInfo = waypointSequence[personName] && waypointSequence[personName][key];
            
            // Always use circle markers now - X will be shown in date labels instead
            return L.circleMarker(latlng, style);
        }
    };

    if (!geoJsonData || !geoJsonData.features || geoJsonData.features.length === 0) {
        return (
            <div style={{
                padding: '20px',
                textAlign: 'center',
                color: '#666',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '20px'
            }}>
                <div>
                    <h3>No itinerary data to display</h3>
                    <p>Your query returned data but no valid coordinates were found.</p>
                </div>
                <div style={{ textAlign: 'left', backgroundColor: '#f5f5f5', padding: '15px', borderRadius: '8px', maxWidth: '600px' }}>
                    <strong>Troubleshooting:</strong>
                    <ol style={{ margin: '10px 0', paddingLeft: '20px' }}>
                        <li>Check that your places have coordinate data:
                            <code style={{ display: 'block', margin: '5px 0', padding: '5px', backgroundColor: 'white' }}>
                                MATCH (pl:Place) RETURN keys(pl) LIMIT 5
                            </code>
                        </li>
                        <li>Verify coordinate field names in your query</li>
                        <li>Check browser console for detailed logs</li>
                    </ol>
                </div>

                {/* Show map anyway with default center */}
                <div style={{ width: '100%', height: '300px', border: '2px dashed #ccc', borderRadius: '8px' }}>
                    <MapContainer
                        center={mapCenter}
                        zoom={mapZoom}
                        style={{ height: '100%', width: '100%' }}
                    >
                        <TileLayer
                            attribution={attribution}
                            url={mapProviderURL}
                        />
                    </MapContainer>
                </div>
            </div>
        );
    }

    return (
        <div style={{ height: '100%', width: '100%', position: 'relative' }}>
            {/* Legend - only show when a route is selected */}
            {selectedRoute && (
                <div style={{
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    zIndex: 1000,
                    backgroundColor: 'rgba(255, 255, 255, 0.95)',
                    padding: '10px 15px',
                    borderRadius: '8px',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
                    border: `2px solid ${getPersonColor(selectedRoute)}`,
                    minWidth: '150px'
                }}>
                    <div style={{
                        fontSize: '14px',
                        fontWeight: 'bold',
                        color: getPersonColor(selectedRoute),
                        marginBottom: '5px',
                        textAlign: 'center'
                    }}>
                        Active Route
                    </div>
                    <div style={{
                        fontSize: '16px',
                        fontWeight: 'bold',
                        color: '#333',
                        textAlign: 'center'
                    }}>
                        {selectedRoute}
                    </div>
                </div>
            )}
            <MapContainer
                center={mapCenter}
                zoom={mapZoom}
                style={{ height: '100%', width: '100%' }}
                key={`${mapCenter[0]}-${mapCenter[1]}-${mapZoom}`}
                eventHandlers={{
                    click: () => {
                        // Clicking on empty map space deselects all
                        setSelectedPerson(null);
                        setSelectedRoute(null);
                        setRenderKey(prev => prev + 1);
                    }
                }}
            >
                <TileLayer
                    attribution={attribution}
                    url={mapProviderURL}
                />

                {geoJsonData && (
                    <GeoJSON
                        data={geoJsonData}
                        style={getFeatureStyle}
                        onEachFeature={onEachFeature}
                        pointToLayer={pointToLayer}
                        key={`geoJson-${selectedPerson || 'none'}-${selectedRoute || 'none'}-${renderKey}`}
                    />
                )}
                
                {/* Display date labels when a route is selected */}
                {selectedRoute && personWaypoints[selectedRoute] && 
                    personWaypoints[selectedRoute].map((waypoint, index) => {
                        const coords = waypoint.geometry.coordinates;
                        const date = waypoint.properties.date_of_stop || waypoint.properties.date || '';
                        
                        // Extract year and month from date string and add appropriate prefix
                        let displayDate = '';
                        
                        // Get waypoint sequence info for this point
                        const key = `${coords[0]}_${coords[1]}`;
                        const sequenceInfo = waypointSequence[selectedRoute] && waypointSequence[selectedRoute][key];
                        
                        if (date) {
                            const match = date.match(/(\d{4})-(\d{2})/);
                            if (match) {
                                const year = match[1];
                                const month = match[2];
                                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                                                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                                const monthName = monthNames[parseInt(month) - 1] || month;
                                
                                if (sequenceInfo) {
                                    if (sequenceInfo.isFirst) {
                                        displayDate = `🟢 ${monthName} ${year}`; // Green circle for start
                                    } else if (sequenceInfo.isLast) {
                                        displayDate = `🏁 ${monthName} ${year}`; // Finishing flag for end
                                    } else {
                                        displayDate = `${monthName} ${year}`; // Plain for middle
                                    }
                                } else {
                                    displayDate = `${monthName} ${year}`;
                                }
                            } else {
                                displayDate = date;
                            }
                        } else {
                            // No date available - handle origin case
                            if (sequenceInfo && sequenceInfo.isFirst) {
                                displayDate = `🟢 Origin`; // Green circle for origin
                            } else if (sequenceInfo && sequenceInfo.isLast) {
                                displayDate = `🏁 Destination`; // Finishing flag for destination
                            } else {
                                displayDate = `Waypoint`; // Plain for middle
                            }
                        }
                        
                        if (displayDate && coords && coords[0] !== null && coords[1] !== null) {
                                // Create a custom DivIcon for the date label
                            const dateIcon = L.divIcon({
                                html: `<div style="
                                    background-color: rgba(255, 255, 255, 0.95);
                                    padding: 3px 8px;
                                    border-radius: 4px;
                                    font-size: 11px;
                                    font-weight: bold;
                                    color: black;
                                    border: 1px solid ${getPersonColor(selectedRoute)};
                                    white-space: nowrap;
                                    min-width: 95px;
                                    text-align: center;
                                    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                                ">${displayDate}</div>`,
                                className: 'date-label-marker',
                                iconSize: [120, 20],
                                iconAnchor: [-20, 10]
                            });
                            
                            
                            return (
                                <Marker
                                    key={`date-${selectedRoute}-${index}`}
                                    position={[coords[1], coords[0]]}
                                    icon={dateIcon}
                                />
                            );
                        }
                        return null;
                    })
                }
            </MapContainer>
        </div>
    );
};

export default NeoItineraryMapChart;